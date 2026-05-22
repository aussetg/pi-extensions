import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/*
 * Models that should run under the apply_patch-only policy.
 * Match the whole GPT-5 family (provider-agnostic), e.g.:
 * - gpt-5
 * - gpt-5.2
 * - gpt-5.2-codex
 * - gpt-5.1-codex-max
 */
const GPT5_MODEL_RE = /^gpt-5(?:[.-].*)?$/;
const GLOBAL_POLICY_STATE_KEY = "__codexApplyPatchToolPolicyState";

type PolicyMode = "codex" | "normal" | null;

interface ApplyPatchToolPolicyState {
  baselineTools: string[] | null;
  policyMode: PolicyMode;
}

function globalPolicyState(): ApplyPatchToolPolicyState {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_POLICY_STATE_KEY]?: ApplyPatchToolPolicyState;
  };
  scope[GLOBAL_POLICY_STATE_KEY] ??= {
    baselineTools: null,
    policyMode: null,
  };
  return scope[GLOBAL_POLICY_STATE_KEY];
}

function sameTools(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((tool, index) => tool === right[index])
  );
}

// Decide whether the active model should be forced into apply_patch-only mode.
export function isCodexModel(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  if (!model) return false;
  return GPT5_MODEL_RE.test(model.id);
}

export function createApplyPatchToolPolicy(pi: ExtensionAPI) {
  const state = globalPolicyState();

  const withoutApplyPatch = (tools: string[]) =>
    tools.filter((tool) => tool !== "apply_patch");

  const codexToolsFromBaseline = (tools: string[]) => {
    const next = new Set(tools);
    next.delete("edit");
    next.delete("write");
    next.add("apply_patch");
    return [...next];
  };

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
      if (state.policyMode !== "codex") {
        state.baselineTools = withoutApplyPatch(pi.getActiveTools());
      }

      const baseline =
        state.baselineTools ?? withoutApplyPatch(pi.getActiveTools());
      state.baselineTools = baseline;
      state.policyMode = "codex";
      setActiveToolsIfChanged(codexToolsFromBaseline(baseline));
      return;
    }

    if (state.policyMode === "codex" && state.baselineTools) {
      state.policyMode = "normal";
      setActiveToolsIfChanged(state.baselineTools);
      return;
    }

    const normalTools = withoutApplyPatch(pi.getActiveTools());
    state.baselineTools = normalTools;
    state.policyMode = "normal";
    setActiveToolsIfChanged(normalTools);
  }

  function captureBaseline(): void {
    const activeTools = pi.getActiveTools();
    if (
      state.policyMode === "codex" &&
      state.baselineTools &&
      sameTools(activeTools, codexToolsFromBaseline(state.baselineTools))
    ) {
      // Hot reload while a Codex model is selected leaves Pi's active tools in
      // the reduced apply_patch-only shape. Keep the real pre-policy baseline
      // so switching away from Codex can restore edit/write.
      return;
    }

    state.baselineTools = withoutApplyPatch(activeTools);
  }

  return { apply, captureBaseline };
}
