import assert from "node:assert/strict";
import test from "node:test";
import {
  createApplyPatchToolPolicy,
  resolveModelToolFamily,
  toolsForProfile,
} from "../src/policy.ts";

const GLOBAL_POLICY_STATE_KEY = "__codexApplyPatchToolPolicyState";

function resetPolicyState() {
  delete globalThis[GLOBAL_POLICY_STATE_KEY];
}

function fakePi(initialTools) {
  let activeTools = [...initialTools];
  return {
    get activeTools() {
      return activeTools;
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(tools) {
      activeTools = [...tools];
    },
  };
}

const codexCtx = { model: { id: "gpt-5.2-codex" } };
const normalCtx = { model: { id: "claude-sonnet-4-5" } };

test("openai profile restores pre-profile baseline after extension reload", () => {
  resetPolicyState();

  const beforeReloadPi = fakePi(["read", "edit", "write", "bash"]);
  const beforeReloadPolicy = createApplyPatchToolPolicy(beforeReloadPi);
  beforeReloadPolicy.captureBaseline();
  beforeReloadPolicy.apply(codexCtx);

  assert.deepEqual(beforeReloadPi.activeTools, ["bash", "view_image", "apply_patch"]);

  const afterReloadPi = fakePi(beforeReloadPi.activeTools);
  const afterReloadPolicy = createApplyPatchToolPolicy(afterReloadPi);
  afterReloadPolicy.captureBaseline();
  afterReloadPolicy.apply(normalCtx);

  assert.deepEqual(afterReloadPi.activeTools, ["read", "edit", "write", "bash"]);
});

test("openai profile captures a fresh baseline when active tools are not the previous profile shape", () => {
  resetPolicyState();

  const firstPi = fakePi(["read", "edit", "write", "bash"]);
  const firstPolicy = createApplyPatchToolPolicy(firstPi);
  firstPolicy.captureBaseline();
  firstPolicy.apply(codexCtx);

  const nextPi = fakePi(["read", "grep", "edit"]);
  const nextPolicy = createApplyPatchToolPolicy(nextPi);
  nextPolicy.captureBaseline();
  nextPolicy.apply(codexCtx);

  assert.deepEqual(nextPi.activeTools, ["view_image", "apply_patch"]);
});

test("tool policy keeps injected tools hidden outside openai profile", () => {
  resetPolicyState();

  const pi = fakePi(["read", "apply_patch", "view_image", "edit"]);
  const policy = createApplyPatchToolPolicy(pi);
  policy.captureBaseline();
  policy.apply(normalCtx);

  assert.deepEqual(pi.activeTools, ["read", "edit"]);
});

test("openai profile drops file convenience tools and keeps non-core helpers", () => {
  assert.deepEqual(
    toolsForProfile("openai", ["read", "grep", "find", "ls", "edit", "write", "bash", "lsp"]),
    ["bash", "lsp", "view_image", "apply_patch"],
  );
});

test("openai profile does not grant apply_patch for read-only baselines", () => {
  assert.deepEqual(toolsForProfile("openai", ["read", "grep", "bash"]), ["bash", "view_image"]);
});

test("openai profile does not grant view_image when baseline cannot read files", () => {
  assert.deepEqual(toolsForProfile("openai", ["bash"]), ["bash"]);
});

test("model family detection covers openai, anthropic, google, mistral, and unknown", () => {
  assert.equal(resolveModelToolFamily({ provider: "openai", id: "gpt-4.1" }), "openai");
  assert.equal(resolveModelToolFamily({ provider: "anthropic", id: "claude-sonnet-4-5" }), "anthropic");
  assert.equal(resolveModelToolFamily({ provider: "google", id: "gemini-3-pro-preview" }), "google");
  assert.equal(resolveModelToolFamily({ provider: "mistral", api: "mistral-conversations", id: "codestral-latest" }), "mistral");
  assert.equal(resolveModelToolFamily({ provider: "local-openai-compatible", id: "llama-4" }), "anthropic");
});

test("openai model identity wins over generic OpenAI-compatible transport", () => {
  for (const id of ["openai/gpt-4.1", "gpt-5.2", "openai/o4-mini", "o3-mini", "openai/gpt-4o-mini"]) {
    assert.equal(resolveModelToolFamily({ api: "openai-responses", provider: "openrouter", id }), "openai", id);
  }

  assert.equal(resolveModelToolFamily({ api: "openai-responses", provider: "openrouter", id: "meta/llama-4" }), "anthropic");
});

test("model identity wins over OpenAI-compatible transport", () => {
  assert.equal(resolveModelToolFamily({ api: "openai-responses", provider: "openrouter", id: "anthropic/claude-sonnet-4.5" }), "anthropic");
  assert.equal(resolveModelToolFamily({ api: "openai-responses", provider: "openrouter", id: "google/gemini-3-pro" }), "google");
  assert.equal(resolveModelToolFamily({ api: "openai-responses", provider: "openrouter", id: "mistral/codestral-latest" }), "mistral");
});
