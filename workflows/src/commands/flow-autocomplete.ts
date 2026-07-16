import type { StructuredWorkflowRegistry } from "../registry/structured-workflows.js";
import { FLOW_SUBCOMMANDS } from "./flow-command-parser.js";

interface Completion {
  value: string;
  label: string;
  description?: string;
}

export function createFlowArgumentCompletions(registry: StructuredWorkflowRegistry) {
  return (argumentPrefix: string): Completion[] | null => {
    const { complete, current } = partialTokens(argumentPrefix);
    if (complete.length === 0) return prefixed(FLOW_SUBCOMMANDS, current);
    const command = complete[0]!;
    if (!FLOW_SUBCOMMANDS.includes(command as (typeof FLOW_SUBCOMMANDS)[number])) return null;
    if ((command === "run" || command === "explain") && complete.length === 1) {
      const refs = registry.list();
      const counts = new Map<string, number>();
      for (const ref of refs) counts.set(ref.name, (counts.get(ref.name) ?? 0) + 1);
      return prefixed(refs.map((ref) => counts.get(ref.name) === 1 ? ref.name : ref.id), current);
    }
    if (command === "list" && complete.at(-1) === "--namespace") return prefixed(["builtin", "user", "project"], current);
    if (command === "drafts" && complete.at(-1) === "--namespace") return prefixed(["user", "project"], current);
    if (["run", "replay", "fresh-run"].includes(command) && current.startsWith("--")) {
      return prefixed(["--await", "--async", "--args"], current);
    }
    return null;
  };
}

function prefixed(values: readonly string[], prefix: string): Completion[] | null {
  const matched = [...new Set(values)]
    .filter((value) => value.startsWith(prefix))
    .sort()
    .map((value) => ({ value, label: value }));
  return matched.length ? matched : null;
}

function partialTokens(input: string): { complete: string[]; current: string } {
  const trailingSpace = /\s$/.test(input);
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  return trailingSpace
    ? { complete: tokens, current: "" }
    : { complete: tokens.slice(0, -1), current: tokens.at(-1) ?? "" };
}
