import type { AgentOptions } from "../types.js";
import { stableHash } from "../utils/hashes.js";

export interface AgentChainKeyInput {
  previousChainKey?: string;
  prompt: string;
  opts: AgentOptions;
  activeTools?: readonly string[];
}

export function computeAgentChainKey(input: AgentChainKeyInput): string {
  const { opts } = input;
  return `v3:${stableHash({
    version: 3,
    previousChainKey: input.previousChainKey ?? null,
    prompt: input.prompt,
    opts: {
      label: opts.label ?? null,
      phase: opts.phase ?? null,
      schema: opts.schema ?? null,
      model: opts.model ?? null,
      isolation: opts.isolation ?? null,
      agentType: opts.agentType ?? null,
    },
    activeTools: normalizeActiveTools(input.activeTools),
  }).slice("sha256:".length)}`;
}

function normalizeActiveTools(activeTools: readonly string[] | undefined): string[] | null {
  if (!activeTools) return null;
  const normalized = [...new Set(activeTools.filter((tool) => typeof tool === "string" && tool !== "workflow"))].sort();
  return normalized.length > 0 ? normalized : null;
}
