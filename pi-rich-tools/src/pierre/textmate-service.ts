import type { SyntaxCategory } from "./types.ts";

export type TextMateSyntaxSpan = {
  row: number;
  startColumn: number;
  endColumn: number;
  category: SyntaxCategory;
};

export type TextMateSyntaxRequest = {
  lang: string;
  lines: string[];
  maxLineLength: number;
};

type ShikiModule = typeof import("shiki");
type ShikiHighlighter = Awaited<ReturnType<ShikiModule["createHighlighter"]>>;
type ShikiToken = {
  content?: unknown;
  explanation?: unknown;
};
type ShikiTokenExplanation = {
  content?: unknown;
  scopes?: unknown;
};
type ShikiTokenScope = {
  scopeName?: unknown;
};

const TEXTMATE_THEME = "dark-plus";
const DEFAULT_TEXTMATE_TOKENIZE_TIME_LIMIT_MS = 250;
const GLOBAL_TEXTMATE_SERVICE_STATE_KEY = "__piRichToolsTextMateServiceState";
const EXTRA_LANGUAGE_ALIASES: Record<string, string> = {
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  golang: "go",
  objectivecpp: "objective-cpp",
  "objective-c++": "objective-cpp",
};

type TextMateServiceState = {
  shiki?: Promise<ShikiModule | undefined>;
  highlighter?: ShikiHighlighter;
  highlighterPromise?: Promise<ShikiHighlighter | undefined>;
  languageMap?: Map<string, string>;
  loadedLanguages: Set<string>;
  failedLanguages: Set<string>;
};

function textMateServiceState(): TextMateServiceState {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_TEXTMATE_SERVICE_STATE_KEY]?: TextMateServiceState;
  };
  scope[GLOBAL_TEXTMATE_SERVICE_STATE_KEY] ??= {
    loadedLanguages: new Set<string>(),
    failedLanguages: new Set<string>(),
  };
  return scope[GLOBAL_TEXTMATE_SERVICE_STATE_KEY];
}

export async function queryTextMateSyntaxSpans(
  request: TextMateSyntaxRequest,
): Promise<TextMateSyntaxSpan[] | undefined> {
  if (request.lines.length === 0) return [];

  const languageId = await textMateLanguageId(request.lang);
  if (!languageId) return undefined;

  const highlighter = await getTextMateHighlighter();
  if (!highlighter) return undefined;
  if (!(await ensureTextMateLanguage(highlighter, languageId))) return undefined;

  try {
    const result = highlighter.codeToTokens(request.lines.join("\n"), {
      lang: languageId as never,
      theme: TEXTMATE_THEME,
      includeExplanation: "scopeName",
      tokenizeMaxLineLength: request.maxLineLength,
      tokenizeTimeLimit: textMateTokenizeTimeLimitMs(),
    }) as { tokens?: unknown };
    if (!Array.isArray(result.tokens)) return undefined;
    return spansFromTextMateTokens(result.tokens);
  } catch {
    return undefined;
  }
}

export function resetTextMateSyntaxService(): void {
  const state = textMateServiceState();
  try {
    state.highlighter?.dispose?.();
  } catch {
    // best effort
  }
  state.highlighter = undefined;
  state.highlighterPromise = undefined;
  state.languageMap = undefined;
  state.loadedLanguages.clear();
  state.failedLanguages.clear();
}

async function getTextMateHighlighter(): Promise<ShikiHighlighter | undefined> {
  const state = textMateServiceState();
  if (state.highlighter) return state.highlighter;
  state.highlighterPromise ??= createTextMateHighlighter();
  const highlighter = await state.highlighterPromise;
  if (highlighter) state.highlighter = highlighter;
  return highlighter;
}

async function createTextMateHighlighter(): Promise<ShikiHighlighter | undefined> {
  const shiki = await getShikiModule();
  if (!shiki) return undefined;

  try {
    return await shiki.createHighlighter({
      themes: [TEXTMATE_THEME],
      langs: [],
      warnings: false,
    });
  } catch {
    return undefined;
  }
}

async function ensureTextMateLanguage(
  highlighter: ShikiHighlighter,
  languageId: string,
): Promise<boolean> {
  const state = textMateServiceState();
  if (state.loadedLanguages.has(languageId)) return true;
  if (state.failedLanguages.has(languageId)) return false;

  try {
    if (highlighter.getLoadedLanguages?.().includes(languageId)) {
      state.loadedLanguages.add(languageId);
      return true;
    }
    await highlighter.loadLanguage(languageId as never);
    state.loadedLanguages.add(languageId);
    return true;
  } catch {
    state.failedLanguages.add(languageId);
    return false;
  }
}

async function textMateLanguageId(lang: string): Promise<string | undefined> {
  const normalized = normalizeLanguageName(lang);
  if (!normalized || isPlainTextLanguage(normalized)) return undefined;

  const languageMap = await textMateLanguageMap();
  const aliased = EXTRA_LANGUAGE_ALIASES[normalized] ?? normalized;
  return languageMap.get(aliased) ?? languageMap.get(normalized);
}

async function textMateLanguageMap(): Promise<Map<string, string>> {
  const state = textMateServiceState();
  if (state.languageMap) return state.languageMap;

  const map = new Map<string, string>();
  const shiki = await getShikiModule();
  if (shiki) {
    for (const info of shiki.bundledLanguagesInfo) {
      map.set(normalizeLanguageName(info.id), info.id);
      for (const alias of info.aliases ?? []) {
        map.set(normalizeLanguageName(alias), info.id);
      }
    }
  }
  for (const [alias, id] of Object.entries(EXTRA_LANGUAGE_ALIASES)) {
    if (map.has(id)) map.set(alias, id);
  }

  state.languageMap = map;
  return map;
}

async function getShikiModule(): Promise<ShikiModule | undefined> {
  const state = textMateServiceState();
  state.shiki ??= import("shiki").catch(() => undefined);
  return state.shiki;
}

function spansFromTextMateTokens(tokenLines: unknown[]): TextMateSyntaxSpan[] {
  const spans: TextMateSyntaxSpan[] = [];
  for (let row = 0; row < tokenLines.length; row++) {
    const tokens = tokenLines[row];
    if (!Array.isArray(tokens)) continue;

    let column = 0;
    for (const token of tokens as ShikiToken[]) {
      const content = typeof token.content === "string" ? token.content : "";
      if (content.length === 0) continue;

      pushExplanationSpans(spans, row, column, content, token.explanation);
      column += content.length;
    }
  }
  return spans;
}

function pushExplanationSpans(
  spans: TextMateSyntaxSpan[],
  row: number,
  tokenColumn: number,
  tokenContent: string,
  explanationValue: unknown,
): void {
  if (!Array.isArray(explanationValue) || explanationValue.length === 0) {
    return;
  }

  let offset = 0;
  for (const value of explanationValue as ShikiTokenExplanation[]) {
    const content = typeof value.content === "string" ? value.content : "";
    if (content.length === 0) continue;

    const start = Math.min(tokenContent.length, offset);
    const end = Math.min(tokenContent.length, offset + content.length);
    const category = textMateCategoryForScopes(scopeNames(value.scopes));
    if (category && end > start) {
      spans.push({
        row,
        startColumn: tokenColumn + start,
        endColumn: tokenColumn + end,
        category,
      });
    }
    offset += content.length;
  }
}

function scopeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const scopes: string[] = [];
  for (const scope of value as ShikiTokenScope[]) {
    if (typeof scope.scopeName === "string") scopes.push(scope.scopeName);
  }
  return scopes;
}

function textMateCategoryForScopes(scopes: string[]): SyntaxCategory | undefined {
  let best: { category: SyntaxCategory; score: number } | undefined;
  for (let index = 0; index < scopes.length; index++) {
    const category = textMateCategoryForScope(scopes[index]!);
    if (!category) continue;
    const score = syntaxCategoryPriority(category) * 100 + index;
    if (!best || score > best.score) best = { category, score };
  }
  return best?.category;
}

function textMateCategoryForScope(scopeName: string): SyntaxCategory | undefined {
  const scope = scopeName.toLowerCase();

  if (scope.includes("comment")) return "comment";
  if (
    scope.includes("string") ||
    scope.includes("markup.inline.raw") ||
    scope.includes("markup.raw") ||
    scope.includes("markup.underline.link")
  ) {
    return "string";
  }
  if (
    scope.includes("constant.numeric") ||
    scope.includes("constant.character.numeric") ||
    scope.includes("constant.other.color")
  ) {
    return "number";
  }
  if (scope.includes("keyword.operator")) return "operator";
  if (
    scope.startsWith("keyword") ||
    scope.startsWith("storage") ||
    scope.includes("markup.heading") ||
    scope.includes("markup.bold") ||
    scope.includes("markup.italic")
  ) {
    return "keyword";
  }
  if (
    scope.includes("entity.name.function") ||
    scope.includes("support.function") ||
    scope.includes("variable.function") ||
    scope.includes("meta.function-call")
  ) {
    return "function";
  }
  if (
    scope.includes("entity.name.type") ||
    scope.includes("entity.name.class") ||
    scope.includes("entity.name.struct") ||
    scope.includes("entity.name.enum") ||
    scope.includes("entity.name.interface") ||
    scope.includes("entity.name.trait") ||
    scope.includes("entity.name.tag") ||
    scope.includes("support.type") ||
    scope.includes("support.class") ||
    scope.includes("storage.type.annotation")
  ) {
    return "type";
  }
  if (
    scope.startsWith("constant") ||
    scope.includes("constant.language") ||
    scope.includes("constant.other")
  ) {
    return "number";
  }
  if (
    scope.startsWith("variable") ||
    scope.includes("support.variable") ||
    scope.includes("entity.other.attribute-name") ||
    scope.includes("entity.name.section")
  ) {
    return "variable";
  }
  if (
    scope.startsWith("punctuation") ||
    scope.includes("meta.brace") ||
    scope.includes("meta.delimiter")
  ) {
    return "punctuation";
  }

  return undefined;
}

function syntaxCategoryPriority(category: SyntaxCategory): number {
  switch (category) {
    case "punctuation":
      return 10;
    case "operator":
      return 20;
    case "variable":
      return 30;
    case "type":
      return 40;
    case "function":
      return 50;
    case "number":
      return 60;
    case "keyword":
      return 70;
    case "string":
      return 80;
    case "comment":
      return 90;
    case "text":
      return 0;
  }
}

function normalizeLanguageName(lang: string): string {
  return lang.trim().toLowerCase().replace(/^\./, "").replace(/\s+/g, "-");
}

function isPlainTextLanguage(lang: string): boolean {
  return lang === "text" || lang === "txt" || lang === "plain" || lang === "plaintext";
}

function textMateTokenizeTimeLimitMs(): number {
  const raw = envValue("PI_TEXTMATE_TOKENIZE_TIME_LIMIT_MS");
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_TEXTMATE_TOKENIZE_TIME_LIMIT_MS;
}

function envValue(name: string): string | undefined {
  return (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env?.[name];
}
