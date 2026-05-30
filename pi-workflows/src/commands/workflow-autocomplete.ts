import type { WorkflowRegistry } from "../persistence/registry.js";
import type { RunStore } from "../persistence/run-store.js";

const SUBCOMMANDS = ["enable", "disable", "toggle", "status", "list", "run", "save", "resume", "stop", "pause", "continue", "skip-agent", "open", "preview-ui", "delete"];

export function createWorkflowAutocomplete(registry: WorkflowRegistry, runStore: RunStore) {
  return (current: any) => ({
    async getSuggestions(lines: string[], line: number, col: number, options: any) {
      const text = (lines[line] ?? "").slice(0, col);
      const match = text.match(/^\/workflow\s*(.*)$/);
      if (!match) return current.getSuggestions(lines, line, col, options);
      const rest = match[1] ?? "";
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      const prefix = rest.endsWith(" ") ? "" : parts.pop() ?? "";
      const first = parts[0];
      if (!first) return completion(prefix, SUBCOMMANDS);
      if (first === "run") return completion(prefix, registry.list().map((r) => r.name));
      if (first === "skip-agent" && parts.length >= 2) {
        const run = runStore.get(parts[1]);
        return completion(prefix, run?.progress.calls.map((c) => c.callId) ?? []);
      }
      if (first === "open" && parts.length >= 3 && parts[2] === "ui") return completion(prefix, [...(runStore.get(parts[1])?.uiViews.map((view) => view.viewId) ?? []), "--profile", "--width"]);
      if (first === "open" && parts.length >= 2) return completion(prefix, ["result", "script", "journal", "transcripts", "ui"]);
      if (first === "preview-ui") return completion(prefix, ["--profile", "--width"]);
      if (["save", "resume", "stop", "pause", "continue", "delete", "open", "skip-agent"].includes(first)) return completion(prefix, runStore.list("all", 80).map((r) => r.runId));
      if (first === "list") return completion(prefix, ["--running", "--completed", "--all"]);
      return completion(prefix, []);
    },
    applyCompletion(lines: string[], line: number, col: number, item: any, prefix: string) {
      return current.applyCompletion(lines, line, col, item, prefix);
    },
    shouldTriggerFileCompletion(lines: string[], line: number, col: number) {
      return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
    },
  });
}

function completion(prefix: string, values: string[]) {
  const items = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
  return items.length > 0 ? { prefix, items } : null;
}
