export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

export interface ModelRegistryModelLike {
  provider?: unknown;
  id?: unknown;
  modelId?: unknown;
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVEL_SET.has(value);
}

export function oneThinkingLevelBelow(level: ThinkingLevel): ThinkingLevel {
  const index = THINKING_LEVELS.indexOf(level);
  return THINKING_LEVELS[Math.max(0, index - 1)]!;
}

export function defaultAgentThinkingFromContext(ctx: unknown): ThinkingLevel | undefined {
  let level: unknown;
  try {
    level = typeof (ctx as any)?.getThinkingLevel === "function" ? (ctx as any).getThinkingLevel() : undefined;
  } catch {
    return undefined;
  }
  return isThinkingLevel(level) ? oneThinkingLevelBelow(level) : undefined;
}

export function modelPatternHasThinkingSuffix(model: unknown): boolean {
  return modelPatternDeclaresThinking(model);
}

export function modelPatternDeclaresThinking(model: unknown, modelRegistryModels?: readonly ModelRegistryModelLike[]): boolean {
  if (typeof model !== "string") return false;
  const reference = model.trim();
  const colon = reference.lastIndexOf(":");
  if (colon < 0) return false;
  const suffix = reference.slice(colon + 1);
  if (!isThinkingLevel(suffix)) return false;
  if (modelReferenceExactlyMatchesKnownModel(reference, modelRegistryModels)) return false;
  return true;
}

function modelReferenceExactlyMatchesKnownModel(reference: string, models: readonly ModelRegistryModelLike[] | undefined): boolean {
  if (!models || models.length === 0) return false;
  const normalizedReference = reference.toLowerCase();
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const id = typeof model.id === "string" ? model.id : typeof model.modelId === "string" ? model.modelId : undefined;
    if (!id) continue;
    if (id.toLowerCase() === normalizedReference) return true;
    if (typeof model.provider === "string" && `${model.provider}/${id}`.toLowerCase() === normalizedReference) return true;
  }
  return false;
}
