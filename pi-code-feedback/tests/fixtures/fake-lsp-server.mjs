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

  if (message.id !== undefined && message.method === "textDocument/hover") {
    const response = {
      jsonrpc: "2.0",
      id: message.id,
      result: mode === "empty" ? null : { contents: { kind: "plaintext", value: `${source} hover` } },
    };
    const delayMs = hoverDelayMs(mode);
    if (delayMs > 0) setTimeout(() => send(response), delayMs);
    else send(response);
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

function shouldLogCancel(value) {
  return value === "cancel-log" || /^hover-delay-\d+$/.test(value);
}

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}
