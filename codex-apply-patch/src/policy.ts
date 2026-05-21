import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

/*
 * Models that should run under the apply_patch-only policy.
 * Match the whole GPT-5 family (provider-agnostic), e.g.:
 * - gpt-5
 * - gpt-5.2
 * - gpt-5.2-codex
 * - gpt-5.1-codex-max
 */
const GPT5_MODEL_RE = /^gpt-5(?:[.-].*)?$/;

// Decide whether the active model should be forced into apply_patch-only mode.
export function isCodexModel(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  if (!model) return false;
  return GPT5_MODEL_RE.test(model.id);
}

export function createApplyPatchToolPolicy(pi: ExtensionAPI) {
  let baselineTools: string[] | null = null;
  let policyMode: "codex" | "normal" | null = null;

  const withoutApplyPatch = (tools: string[]) =>
    tools.filter((tool) => tool !== "apply_patch");

  const setActiveToolsIfChanged = (tools: string[]) => {
    const current = pi.getActiveTools();
    if (
      current.length === tools.length &&
      current.every((tool, index) => tool === tools[index])
    ) {
      return;
    }
    pi.setActiveTools(tools);
  };

  // Enforce apply_patch-only policy for selected models; hide edit/write to avoid mixed diffs.
  function apply(ctx: ExtensionContext): void {
    if (isCodexModel(ctx)) {
      if (policyMode !== "codex") {
        baselineTools = withoutApplyPatch(pi.getActiveTools());
      }

      const next = new Set(
        baselineTools ?? withoutApplyPatch(pi.getActiveTools()),
      );
      next.delete("edit");
      next.delete("write");
      next.add("apply_patch");
      policyMode = "codex";
      setActiveToolsIfChanged([...next]);
      return;
    }

    if (policyMode === "codex" && baselineTools) {
      policyMode = "normal";
      setActiveToolsIfChanged(baselineTools);
      return;
    }

    const normalTools = withoutApplyPatch(pi.getActiveTools());
    baselineTools = normalTools;
    policyMode = "normal";
    setActiveToolsIfChanged(normalTools);
  }

  function captureBaseline(): void {
    baselineTools = pi.getActiveTools();
  }

  return { apply, captureBaseline };
}
