import fs from "node:fs";

const source = process.argv[2] ?? "fake";
const code = process.argv[3] ?? "FAKE";
const severity = Number.parseInt(process.argv[4] ?? "1", 10);
const stderrMode = process.argv[5] ?? "";
const mode = process.argv[6] ?? "diagnostics";
const logPath = process.argv[7];

// Keep deterministic benchmark servers alive until the client sends `exit`.
// Some Node versions do not keep a child process alive on a quiet stdin pipe.
setInterval(() => undefined, 60_000);

if (stderrMode === "warn") {
  process.stderr.write("WARN fake server warning for status tests\n");
}

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainMessages();
});

function drainMessages() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;

    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }

    const length = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;

    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);
    handleMessage(JSON.parse(body));
  }
}

function handleMessage(message) {
  if (message.id !== undefined && message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        capabilities: {
          textDocumentSync: mode === "incremental-log" || mode === "sync-log" ? 2 : 1,
          diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
          codeActionProvider: true,
          hoverProvider: true,
          renameProvider: true,
          semanticTokensProvider: semanticTokensEnabled(mode) ? {
            legend: {
              tokenTypes: ["variable", "class", "function"],
              tokenModifiers: ["declaration", "readonly"],
            },
            full: true,
            range: false,
          } : undefined,
        },
      },
    });
    return;
  }

  if (message.id !== undefined && message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }

  if (message.id !== undefined && message.method === "textDocument/codeAction") {
    const diagnostics = message.params?.context?.diagnostics;
    const hasDiagnostics = Array.isArray(diagnostics) && diagnostics.length > 0;
    const result = mode === "empty" || (mode === "actions-require-diagnostics" && !hasDiagnostics)
      ? []
      : [codeAction(message.params?.textDocument?.uri, { deferEdit: mode === "actions-resolve-require-diagnostics" })];
    send({ jsonrpc: "2.0", id: message.id, result });
    return;
  }

  if (message.id !== undefined && message.method === "codeAction/resolve") {
    const action = typeof message.params === "object" && message.params ? message.params : {};
    send({ jsonrpc: "2.0", id: message.id, result: { ...action, edit: editForUri(action.data?.uri) } });
    return;
  }

  if (message.id !== undefined && message.method === "textDocument/rename") {
    send({ jsonrpc: "2.0", id: message.id, result: renameEdit(message.params?.textDocument?.uri, message.params?.newName) });
    return;
  }

  if (message.id !== undefined && message.method === "textDocument/hover") {
    const response = {
      jsonrpc: "2.0",
      id: message.id,
      result: mode === "empty" ? null : { contents: hoverContents() },
    };
    const delayMs = hoverDelayMs(mode);
    if (delayMs > 0) setTimeout(() => send(response), delayMs);
    else send(response);
    return;
  }

  if (message.id !== undefined && message.method === "textDocument/semanticTokens/full") {
    if (semanticTokensEnabled(mode)) {
      if (shouldLogSemanticTokens(mode)) log({ method: message.method, params: message.params });
      const response = {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          resultId: "fake-semantic-1",
          data: [
            0, 0, 5, 0, 1,
            0, 8, 3, 1, 0,
            1, 2, 4, 2, 0,
          ],
        },
      };
      const delayMs = semanticTokensDelayMs(mode);
      if (delayMs > 0) setTimeout(() => send(response), delayMs);
      else send(response);
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "semantic tokens disabled" } });
    return;
  }

  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }

  if (message.method === "exit") {
    process.exit(0);
  }

  if (message.method === "$/cancelRequest") {
    if (shouldLogCancel(mode)) log({ method: message.method, params: message.params });
    return;
  }

  if (message.method === "textDocument/didOpen") {
    const document = message.params?.textDocument;
    if (mode === "sync-log") log({ method: message.method, params: message.params });
    publishDiagnostics(document?.uri, document?.version);
    return;
  }

  if (message.method === "textDocument/didChange") {
    const document = message.params?.textDocument;
    if (mode === "incremental-log" || mode === "sync-log") {
      log({ method: message.method, params: message.params });
    }
    publishDiagnostics(document?.uri, document?.version);
    return;
  }

  if (message.method === "textDocument/didSave") {
    if (mode === "sync-log") log({ method: message.method, params: message.params });
  }
}

function hoverContents() {
  if (mode === "hover-code") {
    return {
      kind: "markdown",
      value: "```typescript\nfunction fakeHover(value: number): number\n```",
    };
  }
  return { kind: "plaintext", value: `${source} hover` };
}

function log(entry) {
  if (typeof logPath !== "string" || logPath.length === 0) return;
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

function codeAction(uri, options = {}) {
  return {
    title: `${source} fix ${code}`,
    kind: "quickfix",
    data: typeof uri === "string" ? { uri } : undefined,
    edit: options.deferEdit ? undefined : editForUri(uri),
  };
}

function editForUri(uri) {
  if (typeof uri !== "string") return undefined;
  return {
    changes: {
      [uri]: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: `# fixed by ${source}\n`,
        },
      ],
    },
  };
}

function renameEdit(uri, newName) {
  if (typeof uri !== "string") return undefined;
  const text = typeof newName === "string" && newName.length > 0 ? newName : "renamed";
  return {
    changes: {
      [uri]: [
        {
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 13 },
          },
          newText: text,
        },
        {
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 7 },
          },
          newText: text,
        },
      ],
    },
  };
}

function publishDiagnostics(uri, version) {
  if (typeof uri !== "string") return;
  if (mode === "no-diagnostics") return;

  const message = {
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      version: typeof version === "number" ? version : undefined,
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          severity,
          source,
          code,
          message: `${source} diagnostic`,
        },
      ],
    },
  };

  const delayMs = diagnosticDelayMs(mode);
  if (delayMs > 0) {
    setTimeout(() => send(message), delayMs);
  } else {
    send(message);
  }
}

function diagnosticDelayMs(value) {
  const match = /^diagnostics-delay-(\d+)$/.exec(value);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function hoverDelayMs(value) {
  const match = /^hover-delay-(\d+)$/.exec(value);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function semanticTokensDelayMs(value) {
  const match = /^semantic-delay-(\d+)$/.exec(value);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function semanticTokensEnabled(value) {
  return value === "semantic-log" || /^semantic-delay-\d+$/.test(value);
}

function shouldLogSemanticTokens(value) {
  return semanticTokensEnabled(value);
}

function shouldLogCancel(value) {
  return value === "cancel-log" || /^hover-delay-\d+$/.test(value);
}

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}
