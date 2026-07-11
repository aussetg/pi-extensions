import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const codingAgentStub = new URL("./test-pi-coding-agent.mjs", import.meta.url).href;
const toolDependencyStub = new URL("./test-tool-dependencies.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { shortCircuit: true, url: codingAgentStub };
    }
    if (specifier === "@earendil-works/pi-ai" || specifier === "typebox") {
      return { shortCircuit: true, url: toolDependencyStub };
    }
    return nextResolve(specifier, context);
  },
});

const { registerKagiWebTools } = await import("../src/kagi-web-tools.ts");
const { stripTerminalControls } = await import("../src/kagi/terminal.ts");

const UNSAFE_TERMINAL_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

const plainTheme = {
  bold: (text) => text,
  fg: (_color, text) => text,
};

function registeredTools() {
  const tools = new Map();
  registerKagiWebTools({
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  });
  return tools;
}

function webSearchTool() {
  const tool = registeredTools().get("web_search");
  assert.ok(tool);
  return tool;
}

function webFetchTool() {
  const tool = registeredTools().get("web_fetch");
  assert.ok(tool);
  return tool;
}

function mockKagi(t, fetch, options = {}) {
  const previousFetch = globalThis.fetch;
  const previousApiKey = process.env.KAGI_API_KEY;
  const previousConfig = process.env.KAGI_CONFIG_FILE;
  const previousRetries = process.env.KAGI_MAX_RETRIES;

  globalThis.fetch = fetch;
  process.env.KAGI_API_KEY = options.apiKey ?? "test-api-key";
  process.env.KAGI_CONFIG_FILE = options.configPath ?? "/definitely/missing/pi-rich-tools-kagi-test.json";
  process.env.KAGI_MAX_RETRIES = String(options.retries ?? 0);

  t.after(() => {
    globalThis.fetch = previousFetch;
    restoreEnv("KAGI_API_KEY", previousApiKey);
    restoreEnv("KAGI_CONFIG_FILE", previousConfig);
    restoreEnv("KAGI_MAX_RETRIES", previousRetries);
  });
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), { status: 200, ...init });
}

function successfulSearchResponse(overrides = {}) {
  return jsonResponse({
    meta: { trace: "test-trace" },
    data: {
      web: [{ title: "Result", url: "https://example.com", snippet: "Found it" }],
    },
    ...overrides,
  });
}

function rememberFullOutput(t, path) {
  assert.equal(typeof path, "string");
  t.after(() => rm(dirname(path), { recursive: true, force: true }));
  return path;
}

function assertTerminalSafe(value) {
  if (typeof value === "string") {
    assert.doesNotMatch(value, UNSAFE_TERMINAL_CONTROL);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertTerminalSafe(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assert.doesNotMatch(key, UNSAFE_TERMINAL_CONTROL);
      assertTerminalSafe(item);
    }
  }
}

test("terminal sanitizer removes executable controls while preserving readable text", () => {
  const unsafe = [
    "before",
    "\x1b]52;c;clipboard-secret\x07",
    "after ",
    "\x1b[31mred\x1b[0m ",
    "\x1bPdevice-control\x1b\\",
    "plain\btext\rnext",
  ].join("");

  const safe = stripTerminalControls(unsafe);
  assert.equal(safe, "beforeafter red plaintext\nnext");
  assert.doesNotMatch(safe, /clipboard-secret|device-control/);
  assertTerminalSafe(safe);
});

test("registers web_search and web_fetch with bounded parameter schemas", () => {
  const tools = registeredTools();
  assert.deepEqual([...tools.keys()], ["web_search", "web_fetch"]);

  const search = tools.get("web_search");
  assert.equal(search.parameters.properties.query.type, "string");
  assert.equal(search.parameters.properties.numResults.maximum, 100);
  assert.deepEqual(search.parameters.properties.workflow.enum, ["search", "news", "videos", "podcasts", "images"]);
  assert.equal(search.parameters.properties.domainPersonalizations.maxItems, 1000);

  const fetch = tools.get("web_fetch");
  assert.equal(fetch.parameters.properties.urls.minItems, 1);
  assert.equal(fetch.parameters.properties.urls.maxItems, 10);
  assert.equal(fetch.parameters.properties.maxCharacters.maximum, 200000);
});

test("web_search builds the complete Kagi request body and authentication headers", async (t) => {
  let captured;
  mockKagi(t, async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return successfulSearchResponse();
  });

  const result = await webSearchTool().execute("search-request", {
    query: "pi extension API",
    numResults: 25,
    workflow: "news",
    extractCount: 2,
    includeDomains: [" docs.python.org ", "", "github.com"],
    excludeDomains: [" example.invalid "],
    includeKeywords: [" tree sitter "],
    excludeKeywords: [" sponsored "],
    after: "2024-02-29",
    before: "2025-01-01",
    region: " US ",
    searchRegion: " no_region ",
    fileType: ".pdf",
    domainPersonalizations: [
      { domain: " example.com ", kind: "raise" },
      { domain: "  ", kind: "block" },
    ],
    regexPersonalizations: [
      { regex: "^https://old\\.example/(.*)$", replacement: "https://new.example/$1" },
      { regex: "  " },
    ],
    safeSearch: false,
    page: 3,
    timeoutSeconds: 1.5,
  });

  assert.equal(captured.url, "https://kagi.com/api/v1/search");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.Authorization, "Bearer test-api-key");
  assert.equal(captured.init.headers["Content-Type"], "application/json");
  assert.deepEqual(captured.body, {
    query: "pi extension API",
    workflow: "news",
    format: "json",
    limit: 25,
    safe_search: false,
    timeout: 1.5,
    page: 3,
    extract: { count: 2, timeout: 1.5 },
    lens: {
      sites_included: ["docs.python.org", "github.com"],
      sites_excluded: ["example.invalid"],
      keywords_included: ["tree sitter"],
      keywords_excluded: ["sponsored"],
      file_type: "pdf",
      search_region: "no_region",
    },
    filters: { after: "2024-02-29", before: "2025-01-01", region: "US" },
    personalizations: {
      domains: [{ domain: "example.com", kind: "raise" }],
      regexes: [{ regex: "^https://old\\.example/(.*)$", replacement: "https://new.example/$1" }],
    },
  });
  assert.equal(result.details.workflow, "news");
  assert.equal(result.details.numResults, 25);
  assert.equal(result.details.extractCount, 2);
});

test("web_search validates queries, dates, and mutually exclusive lens options before fetching", async (t) => {
  let requests = 0;
  mockKagi(t, async () => {
    requests += 1;
    return successfulSearchResponse();
  });
  const tool = webSearchTool();

  await assert.rejects(tool.execute("empty", { query: "  " }), /non-empty query/);
  await assert.rejects(tool.execute("date-format", { query: "x", after: "2025/01/01" }), /YYYY-MM-DD/);
  await assert.rejects(tool.execute("date-value", { query: "x", after: "2025-02-29" }), /valid ISO date/);
  await assert.rejects(tool.execute("date-order", { query: "x", after: "2025-03-01", before: "2025-02-01" }), /after must not be later/);
  await assert.rejects(tool.execute("relative-date", { query: "x", timeRelative: "week", after: "2025-01-01" }), /mutually exclusive/);
  await assert.rejects(tool.execute("lens-fields", { query: "x", lensId: "custom", includeDomains: ["example.com"] }), /lensId is mutually exclusive/);
  assert.equal(requests, 0);
});

test("web_search maps categories and cleans Kagi HTML fields", async (t) => {
  mockKagi(t, async () => jsonResponse({
    meta: { trace: "mapping-trace", ms: 37 },
    data: {
      web: [{
        title: "<strong>Fish &amp; Chips</strong>",
        url: "https://example.com/story",
        snippet: "First<br>line with <em>style</em> &#x1f600;",
        time: "2026-07-10T12:00:00Z",
        image: { url: "https://example.com/image.webp" },
      }],
      related_questions: [{ props: { question: "Why &lt;now&gt;?", score: 3 } }],
      metadata: { ignored: true },
    },
  }));

  const result = await webSearchTool().execute("search-map", { query: "fish" });
  assert.deepEqual(result.details.categories, [
    { name: "web", count: 1 },
    { name: "related_questions", count: 1 },
  ]);
  assert.equal(result.details.totalResults, 2);
  assert.deepEqual(result.details.results[0], {
    category: "web",
    title: "Fish & Chips",
    url: "https://example.com/story",
    snippet: "First\nline with style 😀",
    time: "2026-07-10T12:00:00Z",
    imageUrl: "https://example.com/image.webp",
  });
  assert.equal(result.details.results[1].title, "Why <now>?");
  assert.match(result.content[0].text, /Found 2 Kagi search result\(s\).*mapping-trace.*37ms/);
  assert.match(result.content[0].text, /## Related Questions \(1\)/);
  assert.doesNotMatch(result.content[0].text, /<strong>|<em>|&amp;/);
});

test("Kagi response data cannot inject terminal controls into results or renderers", async (t) => {
  const clipboard = "\x1b]52;c;clipboard-secret\x07";
  const deviceControl = "\x1bPdevice-secret\x1b\\";
  mockKagi(t, async (url) => {
    if (String(url).endsWith("/search")) {
      return jsonResponse({
        meta: { trace: `safe-${clipboard}trace` },
        data: {
          ["we\x1b[31mb"]: [{
            title: `Safe ${clipboard}Title &#27;]52;c;encoded-secret&#7;`,
            url: `https://example.com/${clipboard}page`,
            snippet: `Readable ${deviceControl}snippet\b`,
          }],
        },
      });
    }
    return jsonResponse({
      data: [{
        url: "https://example.com/page",
        markdown: `# Safe page\n\nbefore${clipboard}after\n${deviceControl}body\x1b[31m red\x1b[0m`,
      }],
      errors: [{ message: `safe ${clipboard}error` }],
    });
  });

  const searchTool = webSearchTool();
  const search = await searchTool.execute("safe-search", { query: "safe" });
  assertTerminalSafe(search);
  assert.doesNotMatch(search.content[0].text, /clipboard-secret|encoded-secret|device-secret/);
  assert.equal(search.details.categories[0].name, "web");
  const renderedSearch = searchTool.renderResult(
    search,
    { expanded: true, isPartial: false },
    plainTheme,
    {},
  ).render(200).join("\n");
  assertTerminalSafe(renderedSearch);

  const fetchTool = webFetchTool();
  const fetched = await fetchTool.execute("safe-fetch", { urls: ["https://example.com/page"] });
  assertTerminalSafe(fetched);
  assert.doesNotMatch(fetched.content[0].text, /clipboard-secret|device-secret/);
  assert.match(fetched.content[0].text, /beforeafter/);
  const renderedFetch = fetchTool.renderResult(
    fetched,
    { expanded: true, isPartial: false },
    plainTheme,
    {},
  ).render(200).join("\n");
  assertTerminalSafe(renderedFetch);
});

test("web_search truncates oversized model output and saves the complete response", async (t) => {
  const longSnippet = Array.from({ length: 120 }, (_, index) => `line-${index} ${"x".repeat(600)}`).join("\n");
  mockKagi(t, async () => jsonResponse({
    data: { web: [{ title: "Large result", url: "https://example.com/large", snippet: longSnippet }] },
  }));

  const result = await webSearchTool().execute("search-truncate", { query: "large" });
  const fullOutputPath = rememberFullOutput(t, result.details.fullOutputPath);
  assert.equal(result.details.truncation.truncated, true);
  assert.equal(result.details.results[0].snippet.length, 500);
  assert.match(result.details.results[0].snippet, /…$/);
  assert.doesNotMatch(result.details.results[0].snippet, /line-119/);
  assert.ok(Buffer.byteLength(JSON.stringify(result.details)) < 64 * 1024);
  assert.match(result.content[0].text, /Output truncated:/);
  assert.match(result.content[0].text, /Full output saved to:/);

  const saved = await readFile(fullOutputPath, "utf8");
  assert.match(saved, /line-0/);
  assert.match(saved, /line-119/);
  assert.doesNotMatch(saved, /Output truncated:/);
});

test("web_fetch builds the Extract request and maps pages by URL", async (t) => {
  let captured;
  mockKagi(t, async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return jsonResponse({
      meta: { trace: "extract-trace", ms: 19 },
      data: [
        { url: "https://example.com/b", error: "robots denied" },
        { url: "https://example.com/a", markdown: "# Alpha\n\nBody" },
      ],
      errors: [{ code: "PAGE_ERROR", location: "pages[1]", message: "one page failed" }],
    });
  });

  const result = await webFetchTool().execute("fetch-map", {
    urls: [" https://example.com/a ", "https://example.com/b"],
    maxCharacters: 5000,
    timeoutSeconds: 2.5,
  });

  assert.equal(captured.url, "https://kagi.com/api/v1/extract");
  assert.deepEqual(captured.body, {
    pages: [{ url: "https://example.com/a" }, { url: "https://example.com/b" }],
    format: "json",
    timeout: 2.5,
  });
  assert.deepEqual(result.details.results, [
    { url: "https://example.com/a", status: "success", title: "Alpha", characters: 13 },
    { url: "https://example.com/b", status: "error", error: "robots denied" },
  ]);
  assert.deepEqual(result.details.errors, [{ code: "PAGE_ERROR", location: "pages[1]", message: "one page failed" }]);
  assert.match(result.content[0].text, /Fetched 1 of 2 URL\(s\).*extract-trace.*19ms/);
  assert.match(result.content[0].text, /# Alpha/);
  assert.match(result.content[0].text, /Status: failed\nError: robots denied/);
  assert.match(result.content[0].text, /PAGE_ERROR — pages\[1\] — one page failed/);
});

test("web_fetch does not reuse a partial response for a missing earlier URL", async (t) => {
  mockKagi(t, async () => jsonResponse({
    data: [{ url: "https://example.com/b", markdown: "# Bravo\n\nBody" }],
  }));

  const result = await webFetchTool().execute("fetch-partial", {
    urls: ["https://example.com/a", "https://example.com/b"],
  });

  assert.deepEqual(result.details.results, [
    {
      url: "https://example.com/a",
      status: "error",
      error: "No markdown content returned",
    },
    {
      url: "https://example.com/b",
      status: "success",
      title: "Bravo",
      characters: 13,
    },
  ]);
  assert.equal(result.content[0].text.match(/Body/g)?.length, 1);
  assert.match(result.content[0].text, /# https:\/\/example\.com\/a[\s\S]*Status: failed/);
});

test("web_fetch rejects empty, excessive, malformed, and non-HTTPS URL lists", async (t) => {
  let requests = 0;
  mockKagi(t, async () => {
    requests += 1;
    return jsonResponse({ data: [] });
  });
  const tool = webFetchTool();

  await assert.rejects(tool.execute("blank", { urls: [" "] }), /at least one URL/);
  await assert.rejects(tool.execute("many", { urls: Array.from({ length: 11 }, (_, index) => `https://example.com/${index}`) }), /at most 10/);
  await assert.rejects(tool.execute("malformed", { urls: ["not a URL"] }), /valid HTTPS URL/);
  await assert.rejects(tool.execute("http", { urls: ["http://example.com"] }), /must use HTTPS/);
  assert.equal(requests, 0);
});

test("web_fetch enforces maxCharacters while preserving complete extracted content on disk", async (t) => {
  const markdown = `# Large page\n\n${"content ".repeat(250)}`;
  mockKagi(t, async () => jsonResponse({
    data: [{ url: "https://example.com/large", markdown }],
  }));

  const result = await webFetchTool().execute("fetch-limit", {
    urls: ["https://example.com/large"],
    maxCharacters: 1000,
  });
  const fullOutputPath = rememberFullOutput(t, result.details.fullOutputPath);

  assert.equal(result.details.fullOutputReason, "one or more pages exceeded maxCharacters");
  assert.equal(result.details.results[0].characters, markdown.length);
  assert.match(result.content[0].text, /Page content truncated to 1000 characters/);
  assert.match(result.content[0].text, /Full extracted content saved to:/);

  const saved = await readFile(fullOutputPath, "utf8");
  assert.match(saved, new RegExp(`${"content ".repeat(20).trim()}`));
  assert.equal(saved.includes(markdown.trim()), true);
  assert.doesNotMatch(saved, /Page content truncated/);
});

test("search renderers provide stable collapsed, expanded, summary, partial, and error views", async () => {
  const tool = webSearchTool();
  const results = Array.from({ length: 6 }, (_, index) => ({
    category: "news",
    title: `Result ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    snippet: `Snippet ${index + 1}`,
    time: `2026-07-0${index + 1}T12:00:00Z`,
  }));
  const result = {
    content: [{ type: "text", text: "model output" }],
    details: {
      ok: true,
      provider: "kagi",
      query: "current news",
      workflow: "news",
      numResults: 10,
      extractCount: 0,
      meta: { ms: 12 },
      totalResults: 6,
      categories: [{ name: "news", count: 6 }],
      results,
    },
  };
  let invalidations = 0;
  const context = { state: {}, invalidate: () => { invalidations += 1; } };

  const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context).render(200).join("\n");
  assert.match(collapsed, /Result 1/);
  assert.match(collapsed, /Result 4/);
  assert.doesNotMatch(collapsed, /Result 5/);
  assert.match(collapsed, /… 2 more results/);
  assert.equal(invalidations, 0, "must not invalidate re-entrantly while rendering");
  await Promise.resolve();
  assert.equal(invalidations, 1);

  tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context);
  await Promise.resolve();
  assert.equal(invalidations, 1);
  const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme, context).render(200).join("\n");
  assert.match(expanded, /Result 6/);

  const call = tool.renderCall({ query: "current news", workflow: "news" }, plainTheme, context).render(200).join("\n");
  assert.match(call, /web_search "current news" — 6 results \[news\] · 12ms/);
  assert.match(tool.renderResult({}, { expanded: false, isPartial: true }, plainTheme, {}).render(200).join("\n"), /Searching Kagi/);
  assert.match(tool.renderResult({ content: [{ type: "text", text: "bad key" }] }, { expanded: false, isPartial: false }, plainTheme, { isError: true }).render(200).join("\n"), /✗ bad key/);
});

test("fetch renderers summarize outcomes and limit only the collapsed view", async () => {
  const tool = webFetchTool();
  const body = `Fetched 1 of 2 URL(s) with Kagi Extract:\n${Array.from({ length: 20 }, (_, index) => `body line ${index + 1}`).join("\n")}`;
  const result = {
    content: [{ type: "text", text: body }],
    details: {
      ok: true,
      provider: "kagi",
      urls: ["https://example.com/a", "https://example.com/b"],
      meta: { ms: 8 },
      results: [
        { url: "https://example.com/a", status: "success" },
        { url: "https://example.com/b", status: "error", error: "failed" },
      ],
      fullOutputReason: "one or more pages exceeded maxCharacters",
    },
  };
  let invalidations = 0;
  const context = { state: {}, invalidate: () => { invalidations += 1; } };

  const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context).render(200).join("\n");
  assert.match(collapsed, /body line 1/);
  assert.doesNotMatch(collapsed, /body line 20/);
  assert.match(collapsed, /truncated:.*to expand/);
  assert.equal(invalidations, 0, "must not invalidate re-entrantly while rendering");
  await Promise.resolve();
  assert.equal(invalidations, 1);

  const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme, context).render(200).join("\n");
  assert.match(expanded, /body line 20/);
  const call = tool.renderCall({ urls: result.details.urls }, plainTheme, context).render(200).join("\n");
  assert.match(call, /web_fetch 2 URLs — 1 fetched · 1 failed · 8ms · saved/);
});

test("Kagi config-file credentials take precedence over the environment fallback", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-kagi-config-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "kagi.json");
  await writeFile(configPath, JSON.stringify({ apiKey: " config-api-key " }));

  let authorization;
  mockKagi(t, async (_url, init) => {
    authorization = init.headers.Authorization;
    return successfulSearchResponse();
  }, { apiKey: "environment-api-key", configPath });

  await webSearchTool().execute("config-key", { query: "test" });
  assert.equal(authorization, "Bearer config-api-key");
});

test("Kagi does not retry non-retryable HTTP errors", async (t) => {
  let requests = 0;
  mockKagi(t, async () => {
    requests += 1;
    return jsonResponse({ errors: [{ message: "invalid \x1b]52;c;secret\x07API \x1b[31mkey\x1b[0m" }] }, {
      status: 401,
      headers: { "x-kagi-trace": "auth-trace" },
    });
  }, { retries: 2 });

  await assert.rejects(webSearchTool().execute("search-401", { query: "test" }), (error) => {
    assert.match(error.message, /Kagi API error \(401\): invalid API key \(trace id: auth-trace\)/);
    assert.doesNotMatch(error.message, /secret/);
    assertTerminalSafe(error.message);
    return true;
  });
  assert.equal(requests, 1);
});

test("Kagi does not retry invalid JSON from a successful request", async (t) => {
  let requests = 0;
  mockKagi(t, async () => {
    requests += 1;
    return new Response("not JSON", { status: 200 });
  }, { retries: 2 });

  await assert.rejects(
    webSearchTool().execute("search-invalid-json", { query: "test" }),
    /Kagi API returned invalid JSON/,
  );
  assert.equal(requests, 1);
});

test("Kagi propagates parent cancellation without retrying", async (t) => {
  let requests = 0;
  mockKagi(t, async (_url, init) => {
    requests += 1;
    return new Promise((_resolve, reject) => {
      const rejectOnAbort = () => reject(init.signal.reason ?? new Error("aborted"));
      if (init.signal.aborted) rejectOnAbort();
      else init.signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
  }, { retries: 2 });

  const controller = new AbortController();
  const pending = webSearchTool().execute("search-abort", { query: "test" }, controller.signal);
  await Promise.resolve();
  controller.abort(new Error("cancelled by test"));

  await assert.rejects(pending, /cancelled by test/);
  assert.equal(requests, 1);
});

test("Kagi still retries explicitly retryable HTTP errors", async (t) => {
  let requests = 0;
  mockKagi(t, async () => {
    requests += 1;
    if (requests === 1) {
      return jsonResponse({ errors: [{ message: "try again" }] }, {
        status: 503,
        headers: { "retry-after": "0" },
      });
    }
    return successfulSearchResponse();
  }, { retries: 2 });

  const result = await webSearchTool().execute("search-503", { query: "test" });
  assert.equal(requests, 2);
  assert.match(result.content[0].text, /Result/);
});
