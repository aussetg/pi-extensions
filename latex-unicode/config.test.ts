// @ts-ignore Node types are supplied by the test runner, not this extension.
import assert from "node:assert/strict";
// @ts-ignore Node types are supplied by the test runner, not this extension.
import test from "node:test";
import { loadConfig, parseConfig } from "./config.ts";

test("render is the configuration default", () => {
	assert.deepEqual(parseConfig({}, "config.json"), { mode: "render", path: "config.json" });
	assert.deepEqual(loadConfig("/definitely/missing/latex-unicode.json"), {
		mode: "render",
		path: "/definitely/missing/latex-unicode.json",
	});
});

test("accepts rewrite and rejects unknown modes", () => {
	assert.deepEqual(parseConfig({ mode: "rewrite" }, "config.json"), {
		mode: "rewrite",
		path: "config.json",
	});
	assert.deepEqual(parseConfig({ mode: "fast" }, "config.json"), {
		mode: "render",
		path: "config.json",
		warning: 'config.json: mode must be "render" or "rewrite"; using render.',
	});
});
