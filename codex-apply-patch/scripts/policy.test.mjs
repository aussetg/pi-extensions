import assert from "node:assert/strict";
import test from "node:test";
import { createApplyPatchToolPolicy } from "../src/policy.ts";

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

test("tool policy restores pre-codex baseline after extension reload", () => {
  resetPolicyState();

  const beforeReloadPi = fakePi(["read", "edit", "write", "bash"]);
  const beforeReloadPolicy = createApplyPatchToolPolicy(beforeReloadPi);
  beforeReloadPolicy.captureBaseline();
  beforeReloadPolicy.apply(codexCtx);

  assert.deepEqual(beforeReloadPi.activeTools, ["read", "bash", "apply_patch"]);

  const afterReloadPi = fakePi(beforeReloadPi.activeTools);
  const afterReloadPolicy = createApplyPatchToolPolicy(afterReloadPi);
  afterReloadPolicy.captureBaseline();
  afterReloadPolicy.apply(normalCtx);

  assert.deepEqual(afterReloadPi.activeTools, ["read", "edit", "write", "bash"]);
});

test("tool policy captures a fresh baseline when active tools are not the previous codex shape", () => {
  resetPolicyState();

  const firstPi = fakePi(["read", "edit", "write", "bash"]);
  const firstPolicy = createApplyPatchToolPolicy(firstPi);
  firstPolicy.captureBaseline();
  firstPolicy.apply(codexCtx);

  const nextPi = fakePi(["read", "grep", "edit"]);
  const nextPolicy = createApplyPatchToolPolicy(nextPi);
  nextPolicy.captureBaseline();
  nextPolicy.apply(codexCtx);

  assert.deepEqual(nextPi.activeTools, ["read", "grep", "apply_patch"]);
});

test("tool policy keeps apply_patch hidden outside codex mode", () => {
  resetPolicyState();

  const pi = fakePi(["read", "apply_patch", "edit"]);
  const policy = createApplyPatchToolPolicy(pi);
  policy.captureBaseline();
  policy.apply(normalCtx);

  assert.deepEqual(pi.activeTools, ["read", "edit"]);
});
