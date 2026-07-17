import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

const codingAgentStub = new URL("./test-pi-coding-agent.mjs", import.meta.url).href;
const workflowRequire = createRequire(new URL("../../workflows/package.json", import.meta.url));
const actualTui = pathToFileURL(workflowRequire.resolve("@earendil-works/pi-tui")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { shortCircuit: true, url: codingAgentStub };
    }
    if (specifier === "@earendil-works/pi-tui") {
      return { shortCircuit: true, url: actualTui };
    }
    return nextResolve(specifier, context);
  },
});

const { registerRichToolRenderers } = await import("../src/rich-tools/extension.ts");
const { clearBashCoalescingState } = await import("../src/rich-tools/bash-render.ts");
const actualCodingAgent = await import(
  "../../workflows/node_modules/@earendil-works/pi-coding-agent/dist/index.js"
);

test("the public self-shell contract suppresses hidden Bash continuation rows", () => {
  actualCodingAgent.initTheme("dark");
  clearBashCoalescingState();

  const tools = new Map();
  registerRichToolRenderers({
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    on() {},
  });

  const bash = tools.get("bash");
  assert.ok(bash, "Bash renderer was not registered");
  assert.equal(bash.renderShell, "self");

  const row = new actualCodingAgent.ToolExecutionComponent(
    "bash",
    "bash-hidden-continuation",
    { command: "c" },
    {},
    bash,
    { requestRender() {} },
    process.cwd(),
  );

  assert.deepEqual(row.render(80), []);
});
