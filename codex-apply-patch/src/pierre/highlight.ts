import type { FileDiffMetadata } from "../../node_modules/@pierre/diffs/dist/types.js";
import { createHighlighter, createJavaScriptRegexEngine } from "shiki";
import type { PierreRendererConfig } from "./config.ts";
import type { PierreTerminalPalette } from "./theme.ts";
import type {
  DiffSpan,
  HastNode,
  HighlightedDiffCode,
  HighlightedDiffSet,
  PierreAppearance,
  SyntaxCategory,
} from "./types.ts";
import { emptyHighlightedDiffSet } from "./types.ts";

const PI_SHIKI_THEME_NAME = "pi-terminal-token-map";
const SYNTAX_HEX: Record<SyntaxCategory, string> = {
  text: "#100000",
  comment: "#100001",
  keyword: "#100002",
  function: "#100003",
  variable: "#100004",
  string: "#100005",
  number: "#100006",
  type: "#100007",
  operator: "#100008",
  punctuation: "#100009",
};
const HEX_TO_SYNTAX = new Map(
  Object.entries(SYNTAX_HEX).map(([category, hex]) => [
    hex.toLowerCase(),
    category as SyntaxCategory,
  ]),
);

let highlighterPromise: Promise<ShikiHighlighter> | undefined;

type ShikiHighlighter = {
  loadLanguage: (...langs: unknown[]) => Promise<void>;
  getLoadedLanguages: () => string[];
  codeToTokensBase: (
    code: string,
    options: Record<string, unknown>,
  ) => ShikiToken[][];
};

interface ShikiToken {
  content: string;
  color?: string;
}

export async function loadHighlightedDiff(
  metadata: FileDiffMetadata,
  config: PierreRendererConfig,
): Promise<HighlightedDiffSet> {
  if (!config.syntaxHighlight.enabled) return emptyHighlightedDiffSet();

  const lineCount = metadata.deletionLines.length + metadata.additionLines.length;
  if (lineCount === 0 || lineCount > config.syntaxHighlight.maxLines) {
    return emptyHighlightedDiffSet();
  }

  try {
    const lang = await loadLanguage(metadata.lang ?? "text");
    const [deletionLines, additionLines] = await Promise.all([
      highlightLines(metadata.deletionLines, lang, config),
      highlightLines(metadata.additionLines, lang, config),
    ]);

    const highlighted = { deletionLines, additionLines };
    return { dark: highlighted, light: highlighted };
  } catch {
    return emptyHighlightedDiffSet();
  }
}

export function normalizeHighlightedDiffSet(
  highlighted: unknown,
): HighlightedDiffSet {
  if (!highlighted || typeof highlighted !== "object") {
    return emptyHighlightedDiffSet();
  }

  const candidate = highlighted as Partial<HighlightedDiffSet>;
  return {
    dark: normalizeHighlightedDiffCode(candidate.dark),
    light: normalizeHighlightedDiffCode(candidate.light),
  };
}

export function hasHighlightedLines(highlighted: HighlightedDiffSet): boolean {
  return (
    highlighted.dark.deletionLines.length > 0 ||
    highlighted.dark.additionLines.length > 0 ||
    highlighted.light.deletionLines.length > 0 ||
    highlighted.light.additionLines.length > 0
  );
}

export function flattenHighlightedLine(
  node: HastNode | undefined,
  _appearance: PierreAppearance,
  palette: PierreTerminalPalette,
  emphasisBg: string,
  fallbackText: string,
): DiffSpan[] {
  const spans: DiffSpan[] = [];

  const visit = (
    current: HastNode | undefined,
    inherited: Pick<DiffSpan, "fg" | "bg">,
  ) => {
    if (!current) return;

    if (current.type === "text") {
      mergeSpan(spans, {
        text: tabify(current.value),
        fg: inherited.fg,
        bg: inherited.bg,
      });
      return;
    }

    const properties = current.properties ?? {};
    const syntaxCategory = normalizeSyntaxCategory(properties["data-pi-syntax"]);
    const nextStyle: Pick<DiffSpan, "fg" | "bg"> = {
      fg: syntaxCategory ? syntaxColor(palette, syntaxCategory) : inherited.fg,
      bg: Object.prototype.hasOwnProperty.call(properties, "data-diff-span")
        ? emphasisBg
        : inherited.bg,
    };

    for (const child of current.children ?? []) visit(child, nextStyle);
  };

  visit(node, {});

  return spans.length > 0
    ? spans
    : fallbackText.length > 0
      ? [{ text: fallbackText }]
      : [];
}

async function highlightLines(
  lines: string[],
  lang: string,
  config: PierreRendererConfig,
): Promise<Array<HastNode | undefined>> {
  if (lines.length === 0) return [];

  const cleanLines = lines.map(cleanDiffLine);
  const highlighter = await getHighlighter();
  const tokens = highlighter.codeToTokensBase(cleanLines.join("\n"), {
    lang,
    theme: PI_SHIKI_THEME_NAME,
    tokenizeMaxLineLength: config.syntaxHighlight.maxLineLength,
    tokenizeTimeLimit: 100,
  });

  return cleanLines.map((line, index) => tokenLineToNode(tokens[index] ?? [], line));
}

async function loadLanguage(lang: string): Promise<string> {
  if (isPlainTextLanguage(lang)) return "text";

  const highlighter = await getHighlighter();
  try {
    if (!highlighter.getLoadedLanguages().includes(lang)) {
      await highlighter.loadLanguage(lang);
    }
    return lang;
  } catch {
    return "text";
  }
}

async function getHighlighter(): Promise<ShikiHighlighter> {
  highlighterPromise ??= (async () => {
    return (await createHighlighter({
      themes: [PI_SHIKI_THEME],
      langs: ["text"],
      engine: createJavaScriptRegexEngine(),
    })) as ShikiHighlighter;
  })();
  return highlighterPromise;
}

function tokenLineToNode(tokens: ShikiToken[], fallbackLine: string): HastNode | undefined {
  if (fallbackLine.length === 0) return undefined;
  if (tokens.length === 0) return textNode(fallbackLine);

  return {
    type: "element",
    tagName: "span",
    properties: {},
    children: tokens.map((token) => {
      const syntaxCategory = syntaxCategoryForColor(token.color);
      return {
        type: "element",
        tagName: "span",
        properties: syntaxCategory ? { "data-pi-syntax": syntaxCategory } : {},
        children: [textNode(token.content)],
      } satisfies HastNode;
    }),
  };
}

function textNode(value: string): HastNode {
  return { type: "text", value };
}

function syntaxCategoryForColor(color: string | undefined): SyntaxCategory | undefined {
  if (!color) return undefined;
  return HEX_TO_SYNTAX.get(color.toLowerCase());
}

function normalizeSyntaxCategory(value: unknown): SyntaxCategory | undefined {
  return typeof value === "string" && isSyntaxCategory(value) ? value : undefined;
}

function isSyntaxCategory(value: string): value is SyntaxCategory {
  return Object.prototype.hasOwnProperty.call(SYNTAX_HEX, value);
}

function syntaxColor(
  palette: PierreTerminalPalette,
  category: SyntaxCategory,
): string {
  switch (category) {
    case "comment":
      return palette.syntaxComment;
    case "keyword":
      return palette.syntaxKeyword;
    case "function":
      return palette.syntaxFunction;
    case "variable":
      return palette.syntaxVariable;
    case "string":
      return palette.syntaxString;
    case "number":
      return palette.syntaxNumber;
    case "type":
      return palette.syntaxType;
    case "operator":
      return palette.syntaxOperator;
    case "punctuation":
      return palette.syntaxPunctuation;
    case "text":
      return palette.syntaxText;
  }
}

function isPlainTextLanguage(lang: string): boolean {
  return lang === "text" || lang === "txt" || lang === "plain" || lang === "plaintext";
}

const PI_SHIKI_THEME = {
  name: PI_SHIKI_THEME_NAME,
  type: "dark",
  fg: SYNTAX_HEX.text,
  bg: "#000000",
  colors: {
    "editor.foreground": SYNTAX_HEX.text,
    "editor.background": "#000000",
  },
  settings: [
    { settings: { foreground: SYNTAX_HEX.text } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: SYNTAX_HEX.comment },
    },
    {
      scope: ["string", "string punctuation.definition.string"],
      settings: { foreground: SYNTAX_HEX.string },
    },
    {
      scope: ["constant.numeric", "constant.language.boolean"],
      settings: { foreground: SYNTAX_HEX.number },
    },
    {
      scope: ["entity.name.type", "support.type", "meta.type"],
      settings: { foreground: SYNTAX_HEX.type },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call"],
      settings: { foreground: SYNTAX_HEX.function },
    },
    {
      scope: [
        "keyword",
        "storage.type",
        "storage.modifier",
        "constant.language",
        "variable.language",
      ],
      settings: { foreground: SYNTAX_HEX.keyword },
    },
    {
      scope: ["keyword.operator", "storage.type.function.arrow"],
      settings: { foreground: SYNTAX_HEX.operator },
    },
    {
      scope: ["variable", "entity.name.variable", "support.variable"],
      settings: { foreground: SYNTAX_HEX.variable },
    },
    {
      scope: ["punctuation", "meta.brace", "meta.delimiter"],
      settings: { foreground: SYNTAX_HEX.punctuation },
    },
  ],
} as const;

export function cleanDiffLine(line: string | undefined): string {
  return tabify(cleanLastNewline(line ?? "").replace(/\r$/, ""));
}

function normalizeHighlightedDiffCode(code: unknown): HighlightedDiffCode {
  if (!code || typeof code !== "object") {
    return { deletionLines: [], additionLines: [] };
  }

  const candidate = code as Partial<HighlightedDiffCode>;
  return {
    deletionLines: Array.isArray(candidate.deletionLines)
      ? candidate.deletionLines
      : [],
    additionLines: Array.isArray(candidate.additionLines)
      ? candidate.additionLines
      : [],
  };
}

function tabify(text: string): string {
  return text.replace(/\t/g, "    ");
}

function cleanLastNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function mergeSpan(target: DiffSpan[], next: DiffSpan): void {
  if (next.text.length === 0) return;

  const previous = target[target.length - 1];
  if (previous && previous.fg === next.fg && previous.bg === next.bg) {
    previous.text += next.text;
    return;
  }

  target.push(next);
}
