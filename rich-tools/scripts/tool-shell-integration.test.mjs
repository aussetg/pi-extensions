import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

const codingAgentStub = new URL("./test-pi-coding-agent.mjs", import.meta.url).href;
const toolDependencyStub = new URL("./test-tool-dependencies.mjs", import.meta.url).href;
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
    if (specifier === "typebox" && context.parentURL?.includes("/rich-tools/src/")) {
      return { shortCircuit: true, url: toolDependencyStub };
    }
    return nextResolve(specifier, context);
  },
});

const { registerRichToolRenderers } = await import("../src/rich-tools/extension.ts");
const { clearBashCoalescingState } = await import("../src/rich-tools/bash-render.ts");
const { registerViewImageTool } = await import("../src/view-image-tool.ts");
const tui = await import(actualTui);
const actualCodingAgent = await import(
  "../../workflows/node_modules/@earendil-works/pi-coding-agent/dist/index.js"
);

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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

test("view_image renders its image inside the self-painted tool shell", (t) => {
  actualCodingAgent.initTheme("dark");

  const previousCapabilities = tui.getCapabilities();
  tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  t.after(() => tui.setCapabilities(previousCapabilities));

  let viewImage;
  registerViewImageTool({
    registerTool(definition) {
      viewImage = definition;
    },
  });

  assert.ok(viewImage, "view_image was not registered");
  assert.equal(viewImage.renderShell, "self");

  const imagePath = "/tmp/view-image-tool-shell.png";
  const row = new actualCodingAgent.ToolExecutionComponent(
    "view_image",
    "view-image-self-shell",
    { path: imagePath },
    {},
    viewImage,
    { requestRender() {} },
    process.cwd(),
  );
  row.markExecutionStarted();
  row.setArgsComplete();
  row.updateResult({
    content: [
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" },
    ],
    details: undefined,
    isError: false,
  });

  // The outer ToolExecutionComponent would append these below the self shell.
  // The custom result renderer owns the image instead.
  assert.equal(row.imageComponents.length, 0);

  const rendered = row.render(100).join("\n");
  assert.match(rendered, /view_image/);
  assert.match(rendered, /view-image-tool-shell\.png/);
  assert.match(rendered, /Read image file \[image\/png\]/);
  assert.match(rendered, /\x1b_G/);
});
