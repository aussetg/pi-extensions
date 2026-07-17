import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = process.argv[2] ?? "fake";
const code = process.argv[3] ?? "FAKE";
const severity = Number.parseInt(process.argv[4] ?? "1", 10);
const stderrMode = process.argv[5] ?? "";
const mode = process.argv[6] ?? "diagnostics";
const logPath = process.argv[7];
const delayedFirstInitialization = claimDelayedFirstInitialization(mode, logPath);
const fixedInitializationDelay = fixedInitializeDelayMs(mode);
const exitAfterFirstInitialization = claimFirstProcess(mode, "exit-after-initialize-once", logPath, "exit-claimed");

if (mode === "initialize-error" || fixedInitializationDelay > 0 || mode === "exit-after-initialize-once" || /^hover-delay-\d+$/.test(mode)) {
  log({ method: "process/start", pid: process.pid });
}

if (delayedFirstInitialization) {
  // Exercise clients that must detach a failed process before its late output
  // and forced exit events arrive. It ignores the graceful termination signal.
  process.on("SIGTERM", () => undefined);
}

// Keep deterministic benchmark servers alive until the client sends `exit`.
// Some Node versions do not keep a child process alive on a quiet stdin pipe.
setInterval(() => undefined, 60_000);

if (stderrMode === "warn") {
  process.stderr.write("WARN fake server warning for status tests\n");
}

let buffer = Buffer.alloc(0);
let workspaceSourceUriCache = [];
const publishedDiagnosticUris = new Set();
let documentDiagnosticRequests = 0;

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
  if (mode === "position-log" && message.id !== undefined && isPositionScopedMethod(message.method)) {
    log({ method: message.method, params: message.params });
  }

  if (message.id === "configuration-log-1" && ("result" in message || "error" in message)) {
    log({ method: "workspace/configuration/response", result: message.result, error: message.error });
    return;
  }

  if (mode === "server-requests-log" && typeof message.id === "string" && message.id.startsWith("server-request-") && ("result" in message || "error" in message)) {
    log({ method: "server/response", id: message.id, result: message.result, error: message.error });
    return;
  }

  if (mode === "request-id-collision" && typeof message.id === "number" && message.method === undefined && ("result" in message || "error" in message)) {
    log({ method: "server/colliding-response", id: message.id, result: message.result, error: message.error });
    return;
  }

  if (message.id !== undefined && message.method === "initialize") {
    if (mode === "initialize-error") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32002, message: "fake deterministic initialization failure" },
      });
      return;
    }
    const diagnosticProvider = diagnosticProviderCapability(mode);
    const workspaceRootPath = typeof message.params?.rootUri === "string"
      ? fileURLToPath(message.params.rootUri)
      : undefined;
    workspaceSourceUriCache = collectWorkspaceSourceUris(workspaceRootPath);
    if (diagnosticProvider || mode === "workspace-files-log") log({ method: message.method, params: message.params });
    const response = {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        capabilities: {
          textDocumentSync: mode === "incremental-log" || mode === "sync-log" ? 2 : 1,
          ...(diagnosticProvider ? { diagnosticProvider } : {}),
          ...(mode.startsWith("typescript-direct-") ? {
            executeCommandProvider: { commands: ["typescript.tsserverRequest"] },
          } : {}),
          codeActionProvider: codeActionProviderCapability(mode),
          hoverProvider: true,
          renameProvider: true,
          ...(fileRenameProviderCapability(mode) ? {
            workspace: {
              fileOperations: {
                willRename: fileRenameProviderCapability(mode),
              },
            },
          } : {}),
        },
      },
    };
    const delayMs = delayedFirstInitialization ? initializeDelayMs(mode) : fixedInitializationDelay;
    if (delayMs > 0) {
      if (fixedInitializationDelay > 0) log({ method: "initialize/start", pid: process.pid });
      setTimeout(() => {
        if (fixedInitializationDelay > 0) log({ method: "initialize/end", pid: process.pid });
        send(response);
      }, delayMs);
    } else {
      send(response);
    }
    if (mode === "configuration-log") {
      setImmediate(() => sendWorkspaceConfigurationRequest());
    }
    return;
  }

  if (message.id !== undefined && message.method === "shutdown") {
    if (mode === "shutdown-gate" && typeof logPath === "string") {
      log({ method: "shutdown", source, pid: process.pid });
      const interval = setInterval(() => {
        if (!fs.existsSync(`${logPath}.release`)) return;
        clearInterval(interval);
        send({ jsonrpc: "2.0", id: message.id, result: null });
      }, 5);
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }

  if (message.id !== undefined && message.method === "textDocument/diagnostic") {
    log({ method: message.method, params: message.params });
    documentDiagnosticRequests += 1;
    if (mode === "pull-unsupported" || (mode === "pull-fails-after-first" && documentDiagnosticRequests > 1)) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found: textDocument/diagnostic" },
      });
      return;
    }

    const result = mode === "pull-invalid"
      ? { items: [] }
      : mode === "pull-malformed-items"
        ? { kind: "full", resultId: "fake-pull-malformed", items: [{}] }
        : {
          kind: "full",
          resultId: "fake-pull-1",
          items: mode === "pull-clean" ? [] : diagnosticItems(),
          ...(mode === "pull-related" ? { relatedDocuments: relatedDiagnosticReports(message.params?.textDocument?.uri) } : {}),
        };
    const respond = () => send({ jsonrpc: "2.0", id: message.id, result });
    const delayMs = pullDiagnosticDelayMs(mode);
    if (delayMs > 0) setTimeout(respond, delayMs);
    else respond();
    return;
  }

  if (message.id !== undefined && message.method === "workspace/diagnostic") {
    log({ method: message.method, params: message.params });
    if (mode === "workspace-pull-unsupported") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found: workspace/diagnostic" },
      });
      return;
    }

    const delayMs = workspaceDiagnosticDelayMs(mode);
    const respond = () => sendWorkspaceDiagnosticResponse(message);
    if (delayMs > 0) setTimeout(respond, delayMs);
    else respond();
    return;
  }

  if (message.id !== undefined && message.method === "textDocument/codeAction") {
    const diagnostics = message.params?.context?.diagnostics;
    const hasDiagnostics = Array.isArray(diagnostics) && diagnostics.length > 0;
    const result = mode === "empty" || (codeActionsRequireDiagnostics(mode) && !hasDiagnostics)
      ? []
      : [codeActionResult(message.params?.textDocument?.uri, { deferEdit: codeActionsDeferEdit(mode) })];
    send({ jsonrpc: "2.0", id: message.id, result });
    return;
  }

  if (message.id !== undefined && message.method === "workspace/executeCommand" && mode.startsWith("typescript-direct-")) {
    const command = message.params?.arguments?.[0];
    const args = message.params?.arguments?.[1];
    log({ method: message.method, command, args });
    const diagnostics = mode === "typescript-direct-diagnostics" && command === "semanticDiagnosticsSync"
      ? [tsServerDiagnostic(args?.file)]
      : [];
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        seq: 0,
        type: "response",
        command,
        request_seq: message.id,
        success: true,
        body: diagnostics,
      },
    });
    return;
  }

  if (message.id !== undefined && message.method === "codeAction/resolve") {
    const action = typeof message.params === "object" && message.params ? message.params : {};
    if (shouldLogCodeActionResolve(mode)) log({ method: message.method, params: message.params });
    send({ jsonrpc: "2.0", id: message.id, result: { ...action, edit: editForUri(action.data?.uri) } });
    return;
  }

  if (message.id !== undefined && message.method === "textDocument/rename") {
    send({ jsonrpc: "2.0", id: message.id, result: renameEdit(message.params?.textDocument?.uri, message.params?.newName, mode) });
    return;
  }

  if (message.id !== undefined && message.method === "workspace/willRenameFiles") {
    log({ method: message.method, params: message.params });
    const result = fileRenameEdit(message.params?.files, mode);
    send({ jsonrpc: "2.0", id: message.id, result });
    return;
  }

  if (message.id !== undefined && message.method === "textDocument/hover") {
    const response = {
      jsonrpc: "2.0",
      id: message.id,
      result: mode === "empty" ? null : { contents: hoverContents() },
    };
    if (mode === "request-id-collision") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        method: "window/showDocument",
        params: { uri: "file:///tmp/collision.ts" },
      });
      setImmediate(() => send(response));
      return;
    }
    const delayMs = hoverDelayMs(mode);
    if (delayMs > 0) setTimeout(() => send(response), delayMs);
    else send(response);
    return;
  }

  if (message.id !== undefined) {
    if (mode === "stdin-gate") log({ method: message.method, id: message.id });
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }

  if (message.method === "exit") {
    process.exit(0);
  }

  if (message.method === "$/cancelRequest") {
    if (shouldLogCancel(mode) || mode === "stdin-gate") log({ method: message.method, params: message.params });
    return;
  }

  if (message.method === "initialized") {
    if (exitAfterFirstInitialization) setTimeout(() => process.exit(1), 10);
    if (mode === "server-requests-log") setImmediate(sendServerRequests);
    if (mode === "stdin-gate") pauseStdinUntilReleased();
    if (mode === "oversized-inbound") {
      setTimeout(() => process.stdout.write("Content-Length: 99999999\r\n\r\n"), 20);
    }
    if (mode === "non-object-inbound") {
      setTimeout(() => send(null), 20);
    }
    if (mode === "close-stdin") {
      fs.closeSync(0);
      log({ method: "stdin/closed", pid: process.pid });
    }
    return;
  }

  if (message.method === "textDocument/didOpen") {
    const document = message.params?.textDocument;
    if (logsDocumentSync(mode)) log({ method: message.method, params: message.params });
    publishDiagnostics(document?.uri, document?.version);
    return;
  }

  if (message.method === "textDocument/didChange") {
    const document = message.params?.textDocument;
    if (mode === "incremental-log" || logsDocumentSync(mode)) {
      log({ method: message.method, params: message.params });
    }
    publishDiagnostics(document?.uri, document?.version);
    return;
  }

  if (message.method === "textDocument/didSave") {
    if (logsDocumentSync(mode)) log({ method: message.method, params: message.params });
    return;
  }

  if (
    (mode === "workspace-files-log" || mode === "file-rename-log" || logsDocumentSync(mode)) &&
    (message.method === "workspace/didChangeWatchedFiles" ||
      message.method === "workspace/didRenameFiles" ||
      message.method === "textDocument/didClose")
  ) {
    log({ method: message.method, params: message.params });
  }
}

function isPositionScopedMethod(method) {
  return method === "textDocument/hover" ||
    method === "textDocument/definition" ||
    method === "textDocument/references" ||
    method === "textDocument/implementation" ||
    method === "textDocument/typeDefinition" ||
    method === "textDocument/codeAction" ||
    method === "textDocument/rename";
}

function logsDocumentSync(value) {
  return value === "sync-log" || value === "workspace-files-log" || value === "file-rename-log" ||
    /^workspace-pull-delay-\d+$/.test(value) || /^pull-delay-\d+$/.test(value) || /^diagnostics-delay-\d+$/.test(value);
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

function sendWorkspaceConfigurationRequest() {
  send({
    jsonrpc: "2.0",
    id: "configuration-log-1",
    method: "workspace/configuration",
    params: {
      items: [
        { section: "ty" },
        { section: "pythonExtension" },
        { section: "ty.pythonExtension.activeEnvironment" },
        { section: "missing.section" },
      ],
    },
  });
}

function sendServerRequests() {
  send({
    jsonrpc: "2.0",
    id: "server-request-show-document",
    method: "window/showDocument",
    params: { uri: "file:///tmp/fake.ts", takeFocus: true },
  });
  send({
    jsonrpc: "2.0",
    id: "server-request-refresh",
    method: "workspace/diagnostic/refresh",
  });
  send({
    jsonrpc: "2.0",
    id: "server-request-apply-edit",
    method: "workspace/applyEdit",
    params: { edit: { changes: {} } },
  });
  send({
    jsonrpc: "2.0",
    id: "server-request-unknown",
    method: "fake/unknownServerRequest",
  });
}

function pauseStdinUntilReleased() {
  process.stdin.pause();
  log({ method: "stdin/paused", pid: process.pid });
  const releasePath = `${logPath}.release`;
  const interval = setInterval(() => {
    if (!fs.existsSync(releasePath)) return;
    clearInterval(interval);
    process.stdin.resume();
    log({ method: "stdin/resumed", pid: process.pid });
  }, 5);
  interval.unref?.();
}

function codeAction(uri, options = {}) {
  return {
    title: `${source} fix ${code}`,
    kind: "quickfix",
    data: typeof uri === "string" ? { uri } : undefined,
    edit: options.deferEdit ? undefined : editForUri(uri),
  };
}

function codeActionResult(uri, options = {}) {
  if (mode === "actions-resolve-command") return topLevelCommand(uri);
  return codeAction(uri, options);
}

function topLevelCommand(uri) {
  return {
    title: `${source} command ${code}`,
    command: `${source}.command.${code}`,
    arguments: typeof uri === "string" ? [uri] : [],
  };
}

function codeActionProviderCapability(value) {
  return value.startsWith("actions-resolve") ? { resolveProvider: true } : true;
}

function diagnosticProviderCapability(value) {
  if (value.startsWith("workspace-pull-")) {
    return {
      identifier: "fake-workspace-pull",
      interFileDependencies: true,
      workspaceDiagnostics: true,
    };
  }
  if (!value.startsWith("pull-")) return undefined;
  return {
    identifier: "fake-pull",
    interFileDependencies: false,
    workspaceDiagnostics: false,
  };
}

function sendWorkspaceDiagnosticResponse(message) {
  const reports = workspaceDiagnosticReports(message.params?.previousResultIds);
  if (mode === "workspace-pull-malformed") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        items: reports.length > 0
          ? [{ ...reports[0], kind: "full", items: [{}] }]
          : [{ uri: "", version: null, kind: "full", items: [] }],
      },
    });
    return;
  }

  if (mode === "workspace-pull-missing") {
    send({ jsonrpc: "2.0", id: message.id, result: { items: reports.slice(0, 1) } });
    return;
  }

  if (mode === "workspace-pull-partial") {
    const split = Math.ceil(reports.length / 2);
    send({
      jsonrpc: "2.0",
      method: "$/progress",
      params: {
        token: message.params?.partialResultToken,
        value: { items: reports.slice(0, split) },
      },
    });
    send({ jsonrpc: "2.0", id: message.id, result: { items: reports.slice(split) } });
    return;
  }

  if (mode === "workspace-pull-partial-overflow") {
    send({
      jsonrpc: "2.0",
      method: "$/progress",
      params: {
        token: message.params?.partialResultToken,
        value: { items: Array.from({ length: 10_001 }, () => reports[0]) },
      },
    });
    send({ jsonrpc: "2.0", id: message.id, result: { items: [] } });
    return;
  }

  send({ jsonrpc: "2.0", id: message.id, result: { items: reports } });
}

function workspaceDiagnosticReports(previousResultIds) {
  const previous = new Map(
    Array.isArray(previousResultIds)
      ? previousResultIds
        .filter((entry) => typeof entry?.uri === "string" && typeof entry?.value === "string")
        .map((entry) => [entry.uri, entry.value])
      : [],
  );
  return workspaceSourceUris().map((uri, index) => {
    if (mode === "workspace-pull-unchanged" && previous.has(uri)) {
      return {
        uri,
        version: null,
        kind: "unchanged",
        resultId: `fake-workspace-${index}-unchanged`,
      };
    }
    return {
      uri,
      version: null,
      kind: "full",
      resultId: `fake-workspace-${index}-full`,
      items: mode === "workspace-pull-clean" ? [] : diagnosticItems(),
    };
  });
}

function workspaceSourceUris() {
  return workspaceSourceUriCache;
}

function collectWorkspaceSourceUris(rootPath) {
  if (typeof rootPath !== "string") return [];
  const files = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const candidate = `${directory}/${entry.name}`;
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && /\.(?:c|cc|cpp|css|go|gleam|h|hs|html|js|json|jsx|lua|py|rs|ts|tsx|yaml|yml)$/.test(entry.name)) {
        files.push(pathToFileURL(candidate).href);
      }
    }
  }
  return files.sort();
}

function workspaceDiagnosticDelayMs(value) {
  const match = /^workspace-pull-delay-(\d+)$/.exec(value);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function codeActionsRequireDiagnostics(value) {
  return value === "actions-require-diagnostics" || value.startsWith("actions-resolve") || value === "actions-defer-no-resolve";
}

function codeActionsDeferEdit(value) {
  return value.startsWith("actions-resolve") || value === "actions-defer-no-resolve";
}

function shouldLogCodeActionResolve(value) {
  return value === "actions-resolve-log-require-diagnostics";
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

function renameEdit(uri, newName, serverMode) {
  if (typeof uri !== "string") return undefined;
  const text = typeof newName === "string" && newName.length > 0 ? newName : "renamed";
  const edits = [
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
  ];
  return serverMode === "rename-versioned"
    ? {
        documentChanges: [{
          textDocument: { uri, version: 1 },
          edits,
        }],
      }
    : {
        changes: {
          [uri]: edits,
        },
      };
}

function fileRenameProviderCapability(value) {
  if (!value.startsWith("file-rename-") || value === "file-rename-unsupported") return undefined;
  return {
    filters: [{
      scheme: "file",
      pattern: { glob: value === "file-rename-filter-miss" ? "**/*.rs" : "**/*", matches: "file" },
    }],
  };
}

function fileRenameEdit(files, serverMode) {
  if (serverMode === "file-rename-no-edits") return null;
  if (serverMode === "file-rename-malformed") return "malformed";
  const pair = Array.isArray(files) ? files[0] : undefined;
  if (typeof pair?.oldUri !== "string" || typeof pair?.newUri !== "string") return null;
  if (serverMode === "file-rename-resource-operation") {
    return {
      documentChanges: [{ kind: "create", uri: new URL("generated.py", pair.oldUri).href }],
    };
  }

  const destinationStem = path.basename(fileURLToPath(pair.newUri), path.extname(fileURLToPath(pair.newUri)));
  const consumerUri = new URL("consumer.py", pair.oldUri).href;
  return {
    changes: {
      [pair.oldUri]: [{
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        newText: "# moved by py\n",
      }],
      [consumerUri]: [{
        range: {
          start: { line: 0, character: 5 },
          end: { line: 0, character: 11 },
        },
        newText: destinationStem,
      }],
    },
  };
}

function publishDiagnostics(uri, version) {
  if (typeof uri !== "string") return;
  if (!shouldPublishDiagnostics(mode)) return;
  const alreadyPublished = publishedDiagnosticUris.has(uri);
  if (mode === "push-deduplicated" && alreadyPublished) return;
  publishedDiagnosticUris.add(uri);

  const message = {
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      version: mode === "push-malformed-version-after-first" && alreadyPublished
        ? "invalid"
        : typeof version === "number" ? version : undefined,
      diagnostics: mode === "push-malformed-diagnostics-after-first" && alreadyPublished
        ? {}
        : diagnosticItems(),
    },
  };

  const delayMs = diagnosticDelayMs(mode);
  if (delayMs > 0) {
    setTimeout(() => send(message), delayMs);
  } else {
    send(message);
  }
}

function diagnosticItems() {
  if (mode === "push-malformed-items") return [{}];

  const malformedDiagnostics = mode === "malformed-diagnostic-position" ? [{
    range: {
      start: { line: -1, character: 4 },
      end: { line: 0, character: 8 },
    },
    severity,
    source,
    code: `${code}-MALFORMED`,
    message: `${source} malformed diagnostic`,
  }] : [];

  return [
    ...malformedDiagnostics,
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
  ];
}

function shouldPublishDiagnostics(value) {
  return value !== "no-diagnostics" &&
    !value.startsWith("typescript-direct-") &&
    (!value.startsWith("pull-") || value === "pull-unsupported") &&
    !value.startsWith("workspace-pull-");
}

function tsServerDiagnostic(file) {
  const relatedFile = typeof file === "string" ? path.join(path.dirname(file), "related.ts") : "/tmp/related.ts";
  return {
    start: { line: 2, offset: 3 },
    end: { line: 2, offset: 8 },
    text: "typescript direct diagnostic",
    code: 2322,
    category: "error",
    relatedInformation: [{
      span: {
        file: relatedFile,
        start: { line: 1, offset: 2 },
        end: { line: 1, offset: 4 },
      },
      message: "related TypeScript location",
      category: "message",
      code: 2322,
    }],
  };
}

function relatedDiagnosticReports(uri) {
  if (typeof uri !== "string") return {};
  return {
    [new URL("related.py", uri).href]: {
      kind: "full",
      items: diagnosticItems(),
    },
  };
}

function diagnosticDelayMs(value) {
  const match = /^diagnostics-delay-(\d+)$/.exec(value);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function pullDiagnosticDelayMs(value) {
  const match = /^pull-delay-(\d+)$/.exec(value);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function hoverDelayMs(value) {
  const match = /^hover-delay-(\d+)$/.exec(value);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function shouldLogCancel(value) {
  return value === "cancel-log" || /^hover-delay-\d+$/.test(value) || /^workspace-pull-delay-\d+$/.test(value);
}

function initializeDelayMs(value) {
  const match = /^initialize-delay-once-(\d+)$/.exec(value);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function fixedInitializeDelayMs(value) {
  const match = /^initialize-delay-(\d+)$/.exec(value);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function claimDelayedFirstInitialization(value, filePath) {
  if (initializeDelayMs(value) <= 0 || typeof filePath !== "string" || filePath.length === 0) return false;

  let first = false;
  try {
    const claim = fs.openSync(`${filePath}.initialize-claimed`, "wx");
    fs.closeSync(claim);
    first = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  fs.appendFileSync(filePath, `${JSON.stringify({ method: "process/start", pid: process.pid, delayedInitialization: first })}\n`, "utf8");
  return first;
}

function claimFirstProcess(value, expectedMode, filePath, suffix) {
  if (value !== expectedMode || typeof filePath !== "string" || filePath.length === 0) return false;
  try {
    const claim = fs.openSync(`${filePath}.${suffix}`, "wx");
    fs.closeSync(claim);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return false;
  }
}

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}
