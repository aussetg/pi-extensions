import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const codingAgentStub = new URL("./test-pi-coding-agent.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { shortCircuit: true, url: codingAgentStub };
    }
    return nextResolve(specifier, context);
  },
});

const {
  beginBashCoalescingAssistantMessage,
  clearBashCoalescingState,
  endBashCoalescingRun,
  rememberToolExecutionEnd,
  rememberToolExecutionStart,
  renderBashCall,
  renderBashResult,
  startBashCoalescingRun,
  syncBashCoalescingAssistantMessage,
} = await import("../src/rich-tools/bash-render.ts");
import {
  resetSharedSyntaxServiceForTests,
  sharedSyntaxServiceStats,
} from "../src/pierre/syntax-service.ts";

const backgroundCodes = {
  toolPendingBg: 45,
  toolSuccessBg: 42,
  toolErrorBg: 41,
};

const theme = {
  fg: (_color, text) => text,
  bg: (color, text) => `\x1b[${backgroundCodes[color] ?? 40}m${text}\x1b[49m`,
  getFgAnsi: () => "",
  getBgAnsi: (color) => `\x1b[${backgroundCodes[color] ?? 40}m`,
  bold: (text) => text,
};

const syntaxCodes = {
  syntaxFunction: 31,
  syntaxString: 32,
  syntaxOperator: 33,
  syntaxKeyword: 34,
  toolOutput: 37,
};
const syntaxCategories = new Map(
  Object.entries(syntaxCodes).map(([category, code]) => [String(code), category]),
);
const syntaxTheme = {
  ...theme,
  fg: (color, text) => {
    const code = syntaxCodes[color];
    return code === undefined ? text : `\x1b[${code}m${text}\x1b[39m`;
  },
};

function callContext(overrides = {}) {
  return {
    argsComplete: true,
    cwd: process.cwd(),
    executionStarted: true,
    expanded: false,
    isError: false,
    isPartial: true,
    toolCallId: "bash-cache-call",
    ...overrides,
  };
}

function hasBackground(lines, color) {
  return lines.some((line) => line.includes(`\x1b[${backgroundCodes[color]}m`));
}

function renderedSyntaxSpans(command) {
  clearBashCoalescingState();
  const component = renderBashCall(
    { command },
    syntaxTheme,
    callContext({ toolCallId: `bash-unicode-${command}` }),
  );
  const rendered = component.render(200).join("\n");
  return [...rendered.matchAll(/\x1b\[(31|32|33|34|37)m([\s\S]*?)\x1b\[39m/g)]
    .map((match) => [syntaxCategories.get(match[1]), match[2]]);
}

test("Bash call and result components reuse rendered rows until their state changes", () => {
  clearBashCoalescingState();

  const call = renderBashCall(
    { command: "printf '%s\\n' hello" },
    theme,
    callContext(),
  );
  const firstCallRows = call.render(80);
  assert.strictEqual(call.render(80), firstCallRows);

  call.invalidate();
  const invalidatedCallRows = call.render(80);
  assert.notStrictEqual(invalidatedCallRows, firstCallRows);
  assert.strictEqual(call.render(80), invalidatedCallRows);

  const updatedCall = renderBashCall(
    { command: "printf '%s\\n' goodbye" },
    theme,
    callContext({ lastComponent: call }),
  );
  assert.strictEqual(updatedCall, call);
  assert.notStrictEqual(updatedCall.render(80), invalidatedCallRows);

  const resultContext = callContext({
    args: { command: "printf '%s\\n' hello" },
    isPartial: false,
    toolCallId: "bash-cache-result",
  });
  const result = renderBashResult(
    { content: [{ type: "text", text: "hello\nworld" }], details: {} },
    { expanded: false, isPartial: false },
    theme,
    resultContext,
  );
  const firstResultRows = result.render(80);
  assert.strictEqual(result.render(80), firstResultRows);

  const updatedResult = renderBashResult(
    { content: [{ type: "text", text: "goodbye" }], details: {} },
    { expanded: false, isPartial: false },
    theme,
    { ...resultContext, lastComponent: result },
  );
  assert.strictEqual(updatedResult, result);
  assert.notStrictEqual(updatedResult.render(80), firstResultRows);
});

test("streamed Bash calls reuse one incremental syntax document", () => {
  clearBashCoalescingState();
  resetSharedSyntaxServiceForTests();

  const context = callContext({ toolCallId: "bash-streamed-syntax" });
  const call = renderBashCall({ command: "prin" }, theme, context);
  call.render(80);

  const updated = renderBashCall(
    { command: "printf '%s\\n' hello" },
    theme,
    { ...context, lastComponent: call },
  );
  updated.render(80);

  const stats = sharedSyntaxServiceStats();
  assert.equal(stats.fullParses, 1);
  assert.equal(stats.incrementalParses, 1);
});

test("streamed exploratory calls keep their last stable frame while syntax is incomplete", () => {
  clearBashCoalescingState();
  startBashCoalescingRun();

  const context = callContext({
    argsComplete: false,
    executionStarted: false,
    toolCallId: "bash-streamed-exploration",
  });
  const call = renderBashCall({ command: "rg -n" }, theme, context);
  const stableRows = call.render(80);
  assert.ok(stableRows.length > 0);

  const incomplete = renderBashCall(
    { command: "rg -n \"" },
    theme,
    { ...context, lastComponent: call },
  );
  assert.strictEqual(incomplete, call);
  assert.deepEqual(incomplete.render(80), stableRows);

  const complete = renderBashCall(
    { command: "rg -n \"needle\"" },
    theme,
    { ...context, lastComponent: incomplete },
  );
  assert.strictEqual(complete, call);
  assert.match(complete.render(80).join("\n"), /needle/);

  clearBashCoalescingState();
});

test("Bash syntax highlighting treats tree-sitter columns as UTF-16 string indexes", () => {
  assert.deepEqual(renderedSyntaxSpans("printf '😀'; printf hi"), [
    ["syntaxFunction", "printf"],
    ["toolOutput", " "],
    ["syntaxString", "'😀'"],
    ["syntaxOperator", ";"],
    ["toolOutput", " "],
    ["syntaxFunction", "printf"],
    ["toolOutput", " hi"],
  ]);

  assert.deepEqual(renderedSyntaxSpans("é=1; if true; then echo ok; fi"), [
    ["syntaxFunction", "é=1"],
    ["syntaxOperator", ";"],
    ["toolOutput", " "],
    ["syntaxKeyword", "if"],
    ["toolOutput", " "],
    ["syntaxFunction", "true"],
    ["syntaxOperator", ";"],
    ["toolOutput", " "],
    ["syntaxKeyword", "then"],
    ["toolOutput", " "],
    ["syntaxFunction", "echo"],
    ["toolOutput", " ok"],
    ["syntaxOperator", ";"],
    ["toolOutput", " "],
    ["syntaxKeyword", "fi"],
  ]);
});

test("an open coalesced Bash box does not flash success between adjacent calls", () => {
  clearBashCoalescingState();
  startBashCoalescingRun();

  const firstId = "bash-coalesced-first";
  const secondId = "bash-coalesced-second";
  const firstArgs = { command: "cat first.txt" };
  let invalidations = 0;
  const leaderContext = callContext({
    invalidate: () => { invalidations += 1; },
    toolCallId: firstId,
  });

  rememberToolExecutionStart("bash", firstId, firstArgs);
  let leader = renderBashCall(firstArgs, theme, leaderContext);
  assert.equal(hasBackground(leader.render(80), "toolPendingBg"), true);

  rememberToolExecutionEnd("bash", firstId, false);
  leader = renderBashCall(
    firstArgs,
    theme,
    { ...leaderContext, isPartial: false, lastComponent: leader },
  );
  const waitingRows = leader.render(80);
  assert.equal(hasBackground(waitingRows, "toolPendingBg"), true);
  assert.equal(hasBackground(waitingRows, "toolSuccessBg"), false);

  beginBashCoalescingAssistantMessage();
  syncBashCoalescingAssistantMessage({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: secondId,
      name: "bash",
      arguments: { command: "c" },
    }],
  });
  leader = renderBashCall(
    firstArgs,
    theme,
    { ...leaderContext, isPartial: false, lastComponent: leader },
  );
  const partialCommandRows = leader.render(80);
  assert.deepEqual(partialCommandRows, waitingRows);
  assert.equal(hasBackground(partialCommandRows, "toolPendingBg"), true);
  assert.equal(hasBackground(partialCommandRows, "toolSuccessBg"), false);

  syncBashCoalescingAssistantMessage({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: secondId,
      name: "bash",
      arguments: { command: "cat second.txt" },
    }],
  }, true);
  rememberToolExecutionStart("bash", secondId, { command: "cat second.txt" });
  leader = renderBashCall(
    firstArgs,
    theme,
    { ...leaderContext, isPartial: false, lastComponent: leader },
  );
  const growingRows = leader.render(80);
  assert.equal(hasBackground(growingRows, "toolPendingBg"), true);
  assert.equal(growingRows.some((line) => line.includes("second.txt")), true);
  assert.deepEqual(growingRows.slice(0, 2), waitingRows.slice(0, 2));

  rememberToolExecutionEnd("bash", secondId, false);
  endBashCoalescingRun();
  leader = renderBashCall(
    firstArgs,
    theme,
    { ...leaderContext, isPartial: false, lastComponent: leader },
  );
  const settledRows = leader.render(80);
  assert.equal(hasBackground(settledRows, "toolPendingBg"), false);
  assert.equal(hasBackground(settledRows, "toolSuccessBg"), true);
  assert.ok(invalidations > 0);

  clearBashCoalescingState();
});

test("a settled exploratory Bash box is an error when every call failed", () => {
  clearBashCoalescingState();
  startBashCoalescingRun();

  const toolCallId = "bash-coalesced-all-failed";
  const args = { command: "rg needle missing-dir; cat missing-file" };
  const context = callContext({ toolCallId });

  rememberToolExecutionStart("bash", toolCallId, args);
  let call = renderBashCall(args, theme, context);
  assert.equal(hasBackground(call.render(80), "toolPendingBg"), true);

  rememberToolExecutionEnd("bash", toolCallId, true);
  endBashCoalescingRun();
  call = renderBashCall(args, theme, {
    ...context,
    isPartial: false,
    lastComponent: call,
  });

  const settledRows = call.render(80);
  assert.equal(hasBackground(settledRows, "toolErrorBg"), true);
  assert.equal(hasBackground(settledRows, "toolSuccessBg"), false);

  clearBashCoalescingState();
});
