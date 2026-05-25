import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/*
 * Model tool profiles.
 *
 * The point is not safety. Safety still belongs to permission gates and tool
 * implementations. This layer only changes the model-visible dialect so each
 * model family sees tools close to the harnesses it was likely tuned around.
 */
const GLOBAL_POLICY_STATE_KEY = "__piRichToolsToolProfilePolicyState";

export type ModelToolFamily = "openai" | "anthropic" | "google" | "mistral";
export type ToolProfileName = ModelToolFamily;

type PolicyMode = ToolProfileName | null;

type ModelLike = {
  id?: string;
  provider?: string;
  name?: string;
  api?: string;
  baseUrl?: string;
};

interface ToolProfilePolicyState {
  baselineTools: string[] | null;
  policyMode: PolicyMode;
}

const PROFILE_INJECTED_TOOLS = new Set(["apply_patch", "view_image"]);

const OPENAI_HIDDEN_BASELINE_TOOLS = new Set([
  // OpenAI-style agents are best with shell for inspection and patch for edits.
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
]);

const MUTATING_BASELINE_TOOLS = new Set(["edit", "write", "apply_patch"]);
const IMAGE_VIEW_BASELINE_TOOLS = new Set(["read", "view_image"]);

const OPENAI_MODEL_RE = /(^|[/\s:_.-])(?:gpt(?:[-_./]?(?:\d[a-z0-9]*|oss))|o[134]|codex)(?=$|[/\s:_.-])/;
const ANTHROPIC_MODEL_RE = /(^|[/\s:_.-])(anthropic|claude)(?=$|[/\s:_.-])/;
const GOOGLE_MODEL_RE = /(^|[/\s:_.-])(google|gemini|gemma)(?=$|[/\s:_.-])/;
const MISTRAL_MODEL_RE = /(^|[/\s:_.-])(mistral|mixtral|codestral|magistral)(?=$|[/\s:_.-])/;

function modelText(model: ModelLike | null | undefined, fields: (keyof ModelLike)[]): string {
  if (!model) return "";
  return fields
    .map((field) => model[field])
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

function transportText(model: ModelLike | null | undefined): string {
  return modelText(model, ["provider", "api", "baseUrl"]);
}

function identityText(model: ModelLike | null | undefined): string {
  return modelText(model, ["id", "name"]);
}

function providerIdentityText(model: ModelLike | null | undefined): string {
  return modelText(model, ["provider", "baseUrl"]);
}

function fieldLower(model: ModelLike | null | undefined, field: keyof ModelLike): string {
  const value = model?.[field];
  return typeof value === "string" ? value.toLowerCase() : "";
}

function globalPolicyState(): ToolProfilePolicyState {
  const scope = globalThis as typeof globalThis & {
    [GLOBAL_POLICY_STATE_KEY]?: ToolProfilePolicyState;
  };
  scope[GLOBAL_POLICY_STATE_KEY] ??= {
    baselineTools: null,
    policyMode: null,
  };
  return scope[GLOBAL_POLICY_STATE_KEY];
}

function matchesBrand(text: string, regex: RegExp): boolean {
  regex.lastIndex = 0;
  return regex.test(text);
}

export function resolveModelToolFamily(model: ModelLike | null | undefined): ModelToolFamily {
  const identity = identityText(model);

  // Prefer the actual model identity over the transport. This handles Claude,
  // Gemini, or Mistral models served through OpenAI-compatible gateways.
  if (matchesBrand(identity, ANTHROPIC_MODEL_RE)) return "anthropic";
  if (matchesBrand(identity, GOOGLE_MODEL_RE)) return "google";
  if (matchesBrand(identity, MISTRAL_MODEL_RE)) return "mistral";
  if (matchesBrand(identity, OPENAI_MODEL_RE)) return "openai";

  const providerName = fieldLower(model, "provider");
  if (providerName === "anthropic" || providerName.startsWith("anthropic-")) return "anthropic";
  if (providerName === "google" || providerName === "google_ai" || providerName.startsWith("google-")) return "google";
  if (providerName === "mistral" || providerName.startsWith("mistral-")) return "mistral";
  if (
    providerName === "openai" ||
    providerName === "openai-codex" ||
    providerName === "chatgpt_oauth" ||
    providerName === "azure-openai" ||
    providerName.startsWith("azure-openai-")
  ) {
    return "openai";
  }

  const api = fieldLower(model, "api");
  if (api === "anthropic-messages") return "anthropic";
  if (api === "google-generative-ai" || api === "google-vertex") return "google";
  if (api === "mistral-conversations") return "mistral";
  if (api === "openai-codex-responses") return "openai";

  const provider = providerIdentityText(model);
  if (matchesBrand(provider, ANTHROPIC_MODEL_RE)) return "anthropic";
  if (matchesBrand(provider, GOOGLE_MODEL_RE)) return "google";
  if (matchesBrand(provider, MISTRAL_MODEL_RE)) return "mistral";

  const transport = transportText(model);
  if (transport.includes("anthropic")) return "anthropic";
  if (transport.includes("google")) return "google";
  if (transport.includes("mistral")) return "mistral";

  // Unknown models get the Anthropic-like profile. It is the least surprising
  // default for our current lowercase Pi tools and avoids exposing apply_patch
  // to models that were not selected for the OpenAI profile.
  return "anthropic";
}

export function resolveToolProfileName(ctx: ExtensionContext | { model?: ModelLike | null }): ToolProfileName {
  return resolveModelToolFamily(ctx.model as ModelLike | null | undefined);
}

function sameTools(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((tool, index) => tool === right[index])
  );
}

function withoutProfileInjectedTools(tools: string[]): string[] {
  return tools.filter((tool) => !PROFILE_INJECTED_TOOLS.has(tool));
}

function hasMutationCapability(tools: string[]): boolean {
  return tools.some((tool) => MUTATING_BASELINE_TOOLS.has(tool));
}

function hasImageViewCapability(tools: string[]): boolean {
  return tools.some((tool) => IMAGE_VIEW_BASELINE_TOOLS.has(tool));
}

export function toolsForProfile(profile: ToolProfileName, baselineTools: string[]): string[] {
  if (profile !== "openai") return withoutProfileInjectedTools(baselineTools);

  const next = baselineTools.filter((tool) => !OPENAI_HIDDEN_BASELINE_TOOLS.has(tool) && tool !== "apply_patch");
  if (hasImageViewCapability(baselineTools) && !next.includes("view_image")) next.push("view_image");
  if (hasMutationCapability(baselineTools)) next.push("apply_patch");
  return next;
}

export function usesOpenAIToolProfile(ctx: ExtensionContext): boolean {
  return resolveToolProfileName(ctx) === "openai";
}

export function createToolProfilePolicy(pi: ExtensionAPI) {
  const state = globalPolicyState();

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

  // Enforce the selected model-family tool profile while preserving the user's
  // real baseline so switching models can restore it cleanly.
  function apply(ctx: ExtensionContext): void {
    const profile = resolveToolProfileName(ctx);

    if (profile === "openai") {
      if (state.policyMode !== "openai") {
        state.baselineTools = withoutProfileInjectedTools(pi.getActiveTools());
      }

      const baseline = state.baselineTools ?? withoutProfileInjectedTools(pi.getActiveTools());
      state.baselineTools = baseline;
      state.policyMode = profile;
      setActiveToolsIfChanged(toolsForProfile(profile, baseline));
      return;
    }

    if (state.policyMode === "openai" && state.baselineTools) {
      state.policyMode = profile;
      setActiveToolsIfChanged(toolsForProfile(profile, state.baselineTools));
      return;
    }

    const normalTools = withoutProfileInjectedTools(pi.getActiveTools());
    state.baselineTools = normalTools;
    state.policyMode = profile;
    setActiveToolsIfChanged(toolsForProfile(profile, normalTools));
  }

  function captureBaseline(): void {
    const activeTools = pi.getActiveTools();
    if (
      state.policyMode &&
      state.baselineTools &&
      sameTools(activeTools, toolsForProfile(state.policyMode, state.baselineTools))
    ) {
      // Hot reload while a profile is selected leaves Pi's active tools in the
      // reduced profile shape. Keep the real pre-policy baseline so switching
      // away can restore hidden tools such as read/edit/write.
      return;
    }

    state.baselineTools = withoutProfileInjectedTools(activeTools);
  }

  return { apply, captureBaseline };
}
