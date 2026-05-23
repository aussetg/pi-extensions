import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { createDiagnosticSnapshot } from "../diagnostics/snapshots.ts";
import type { DiagnosticRefreshResult, DiagnosticSnapshot, LspClientState, LspClientStatus, LspDiagnostic, LspServerLog, LspServerLogLevel, RelatedLocation, SemanticToken, SemanticTokenLegend, SemanticTokenOverlay } from "../types.ts";
import { filePathToUri, lspRangeToExternal, type LspRange } from "./positions.ts";
import type { LanguageServerDefinition } from "./servers.ts";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface OpenDocument {
  uri: string;
  filePath: string;
  languageId: string;
  version: number;
  content: string;
}

interface DiagnosticEntry {
  uri: string;
  version?: number;
  diagnostics: RawLspDiagnostic[];
  receivedAt: number;
}

interface DiagnosticWaiter {
  minVersion: number;
  touchedAt: number;
  finish(fresh: boolean): void;
}

interface RawLspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message?: string;
  relatedInformation?: RawRelatedInformation[];
}

interface RawRelatedInformation {
  location?: {
    uri?: string;
    range?: LspRange;
  };
  message?: string;
}

interface PublishDiagnosticsParams {
  uri?: string;
  diagnostics?: RawLspDiagnostic[];
  version?: number;
}

interface SemanticTokenCacheEntry {
  serverId: string;
  uri: string;
  version: number;
  tokens: SemanticToken[];
  legend: SemanticTokenLegend;
  resultId?: string;
  requestedAt: number;
  receivedAt: number;
}

interface SemanticTokenPendingRequest {
  version: number;
  timeoutMs: number;
  request: Promise<SemanticTokenOverlay>;
}

interface RawSemanticTokensResult {
  resultId?: string;
  data: number[];
}

interface SemanticTokensProviderInfo {
  legend: SemanticTokenLegend;
  full: boolean;
}

interface TextDocumentContentChange {
  text: string;
  range?: LspRange;
  rangeLength?: number;
}

const TEXT_DOCUMENT_SYNC_NONE = 0;
const TEXT_DOCUMENT_SYNC_FULL = 1;
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2;

type TextDocumentSyncKind = typeof TEXT_DOCUMENT_SYNC_NONE | typeof TEXT_DOCUMENT_SYNC_FULL | typeof TEXT_DOCUMENT_SYNC_INCREMENTAL;

export interface TouchDocumentOptions {
  timeoutMs: number;
  settleMs: number;
}

export interface SemanticTokensOverlayOptions {
  waitMs?: number;
  timeoutMs?: number;
  forceRefresh?: boolean;
}

const SEMANTIC_TOKEN_TYPES = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "event",
  "function",
  "method",
  "macro",
  "keyword",
  "modifier",
  "comment",
  "string",
  "number",
  "regexp",
  "operator",
  "decorator",
];
const SEMANTIC_TOKEN_MODIFIERS = [
  "declaration",
  "definition",
  "readonly",
  "static",
  "deprecated",
  "abstract",
  "async",
  "modification",
  "documentation",
  "defaultLibrary",
];

const DEFAULT_SEMANTIC_TOKEN_WAIT_MS = 50;
const DEFAULT_SEMANTIC_TOKEN_TIMEOUT_MS = 5_000;

export class LspClient {
  readonly id: string;
  readonly root: string;
  readonly definition: LanguageServerDefinition;

  private process?: ChildProcessWithoutNullStreams;
  private state: LspClientState = "stopped";
  private nextRequestId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private inputBuffer = Buffer.alloc(0);
  private initializePromise?: Promise<void>;
  private documents = new Map<string, OpenDocument>();
  private diagnostics = new Map<string, DiagnosticEntry>();
  private diagnosticWaiters = new Map<string, Set<DiagnosticWaiter>>();
  private semanticTokens = new Map<string, SemanticTokenCacheEntry>();
  private semanticTokenRequests = new Map<string, SemanticTokenPendingRequest>();
  private capabilities: unknown;
  private lastDiagnosticsAt?: number;
  private lastDiagnosticDurationMs?: number;
  private lastDiagnosticTimedOut?: boolean;
  private lastError?: string;
  private lastServerLog?: LspServerLog;

  constructor(definition: LanguageServerDefinition, root: string) {
    this.definition = definition;
    this.id = definition.id;
    this.root = path.resolve(root);
  }

  async touchDocument(filePath: string, content: string, options: TouchDocumentOptions): Promise<DiagnosticSnapshot | undefined> {
    return (await this.touchDocumentDetailed(filePath, content, options)).snapshot;
  }

  async touchDocumentDetailed(filePath: string, content: string, options: TouchDocumentOptions): Promise<DiagnosticRefreshResult> {
    await this.ensureStarted();

    const touchedAt = Date.now();
    const document = this.syncDocument(filePath, content);

    this.notify("textDocument/didSave", textDocumentDidSaveParams(document.uri, content, this.capabilities));

    const fresh = await this.waitForDiagnostics(document.uri, document.version, touchedAt, options.timeoutMs, options.settleMs);
    const completedAt = Date.now();
    this.lastDiagnosticDurationMs = completedAt - touchedAt;
    this.lastDiagnosticTimedOut = !fresh;
    return {
      snapshot: this.snapshot(),
      fresh,
      timedOut: !fresh,
      requestedAt: touchedAt,
      completedAt,
    };
  }

  async ensureDocument(filePath: string, content: string): Promise<void> {
    await this.ensureStarted();
    this.syncDocument(filePath, content);
  }

  async start(): Promise<void> {
    await this.ensureStarted();
  }

  snapshot(): DiagnosticSnapshot {
    const diagnostics = [...this.diagnostics.values()].flatMap((entry) => this.normalizeDiagnostics(entry));
    return createDiagnosticSnapshot(diagnostics);
  }

  diagnosticsForUri(uri: string): LspDiagnostic[] {
    const entry = this.diagnostics.get(uri);
    return entry ? this.normalizeDiagnostics(entry) : [];
  }

  hasDiagnosticsForUri(uri: string): boolean {
    return this.diagnostics.has(uri);
  }

  forgetDocument(filePath: string): void {
    const uri = filePathToUri(filePath);
    if (this.documents.has(uri) && this.state === "ready") {
      try {
        this.notify("textDocument/didClose", { textDocument: { uri } });
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    this.documents.delete(uri);
    this.diagnostics.delete(uri);
    this.semanticTokens.delete(uri);
  }

  async request(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
    await this.ensureStarted();
    return this.sendRequest(method, params, timeoutMs);
  }

  async requestForDocument(filePath: string, content: string, method: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    await this.ensureDocument(filePath, content);
    return this.request(method, params, timeoutMs);
  }

  async semanticTokensOverlay(filePath: string, content: string, options: SemanticTokensOverlayOptions = {}): Promise<SemanticTokenOverlay> {
    await this.ensureStarted();

    const document = this.syncDocument(filePath, content);
    const provider = semanticTokensProvider(this.capabilities);
    if (!provider?.full) {
      return {
        serverId: this.id,
        uri: document.uri,
        version: document.version,
        state: "unsupported",
        stale: false,
        tokens: [],
      };
    }

    const cached = this.semanticTokens.get(document.uri);
    if (!options.forceRefresh && cached?.version === document.version) {
      return semanticTokenOverlayFromCache(cached, "ready", false);
    }

    const refresh = this.startSemanticTokensRefresh(
      document,
      provider,
      options.timeoutMs ?? DEFAULT_SEMANTIC_TOKEN_TIMEOUT_MS,
    );
    const waitMs = Math.max(0, options.waitMs ?? DEFAULT_SEMANTIC_TOKEN_WAIT_MS);
    if (waitMs > 0) {
      const fresh = await Promise.race([
        refresh,
        sleep(waitMs).then(() => undefined),
      ]);
      if (fresh) return fresh;
    }

    if (cached) {
      return semanticTokenOverlayFromCache(cached, "refreshing", cached.version !== document.version);
    }

    return {
      serverId: this.id,
      uri: document.uri,
      version: document.version,
      state: "refreshing",
      stale: false,
      tokens: [],
      legend: provider.legend,
    };
  }

  getCapabilities(): unknown {
    return this.capabilities;
  }

  getStatus(): LspClientStatus {
    return {
      id: this.id,
      root: this.root,
      command: this.definition.command,
      args: this.definition.args,
      state: this.state,
      pid: this.process?.pid,
      openDocuments: this.documents.size,
      diagnosticFiles: this.diagnostics.size,
      lastDiagnosticsAt: this.lastDiagnosticsAt,
      lastDiagnosticDurationMs: this.lastDiagnosticDurationMs,
      lastDiagnosticTimedOut: this.lastDiagnosticTimedOut,
      lastError: this.lastError,
      lastServerLog: this.lastServerLog,
    };
  }

  async shutdown(): Promise<void> {
    this.finishDiagnosticWaiters(false);
    if (!this.process || this.state === "stopped") return;

    try {
      await this.sendRequest("shutdown", undefined, 1500);
      this.notify("exit");
    } catch {
      // Fall through to killing the process.
    }

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("LSP client stopped"));
    }
    this.pending.clear();

    this.process.kill();
    this.state = "stopped";
    this.process = undefined;
    this.initializePromise = undefined;
    this.documents.clear();
    this.diagnostics.clear();
    this.semanticTokens.clear();
    this.semanticTokenRequests.clear();
  }

  private async ensureStarted(): Promise<void> {
    if (this.state === "ready") return;
    if (this.initializePromise) return this.initializePromise;

    this.state = "starting";
    this.initializePromise = this.startAndInitialize();
    return this.initializePromise;
  }

  private async startAndInitialize(): Promise<void> {
    try {
      const child = spawn(this.definition.command, this.definition.args, {
        cwd: this.root,
        stdio: "pipe",
      });
      this.process = child;

      child.stdout.on("data", (chunk: Buffer) => this.handleData(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text.length > 0) this.lastServerLog = classifyServerLog(text.slice(-1000));
      });
      child.on("error", (error) => {
        this.lastError = error.message;
        this.state = "failed";
        this.rejectPending(error);
        this.finishDiagnosticWaiters(false);
      });
      child.on("exit", (code, signal) => {
        this.initializePromise = undefined;
        if (this.state !== "stopped") {
          this.state = code === 0 ? "stopped" : "failed";
          if (code !== 0 || signal) this.lastError = `process exited code=${code ?? "null"} signal=${signal ?? "null"}`;
          this.rejectPending(new Error(this.lastError ?? "LSP process exited"));
          this.finishDiagnosticWaiters(false);
        }
      });

      const initializeResult = await this.sendRequest("initialize", this.initializeParams(), 10_000);
      this.capabilities = readServerCapabilities(initializeResult);
      this.notify("initialized", {});
      this.state = "ready";
      this.initializePromise = undefined;
    } catch (error) {
      this.state = "failed";
      this.lastError = error instanceof Error ? error.message : String(error);
      this.initializePromise = undefined;
      throw error;
    }
  }

  private initializeParams(): Record<string, unknown> {
    const rootUri = filePathToUri(this.root);
    return {
      processId: typeof process.pid === "number" ? process.pid : null,
      clientInfo: { name: "pi-code-feedback" },
      rootPath: this.root,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) || this.root }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true, versionSupport: true, codeDescriptionSupport: true, dataSupport: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          implementation: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          codeAction: { isPreferredSupport: true, dataSupport: true, resolveSupport: { properties: ["edit"] } },
          rename: { prepareSupport: true },
          semanticTokens: {
            dynamicRegistration: false,
            requests: { range: true, full: { delta: false } },
            tokenTypes: SEMANTIC_TOKEN_TYPES,
            tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
            formats: ["relative"],
            overlappingTokenSupport: true,
            multilineTokenSupport: true,
            serverCancelSupport: true,
            // We fetch semantic tokens lazily and do not let them replace the
            // renderer's Tree-sitter pass. Ask servers for a complete token set
            // so a semantic-only inspector does not look like syntax vanished.
            augmentsSyntaxTokens: false,
          },
        },
        workspace: {
          applyEdit: false,
          workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] },
          symbol: { resolveSupport: { properties: ["location.range"] } },
          configuration: false,
          workspaceFolders: true,
        },
        window: { workDoneProgress: false },
      },
      initializationOptions: {},
    };
  }

  private syncDocument(filePath: string, content: string): OpenDocument {
    const uri = filePathToUri(filePath);
    const languageId = this.definition.languageId(filePath);
    const document = this.documents.get(uri);

    if (!document) {
      const opened: OpenDocument = { uri, filePath, languageId, version: 1, content };
      this.documents.set(uri, opened);
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId,
          version: opened.version,
          text: content,
        },
      });
      return opened;
    }

    document.filePath = filePath;
    document.languageId = languageId;
    if (document.content === content) return document;

    const oldContent = document.content;
    document.version += 1;
    document.content = content;

    const syncKind = textDocumentChangeSyncKind(this.capabilities);
    if (syncKind !== TEXT_DOCUMENT_SYNC_NONE) {
      const contentChanges = syncKind === TEXT_DOCUMENT_SYNC_INCREMENTAL
        ? [incrementalContentChange(oldContent, content)]
        : [{ text: content }];
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: document.version },
        contentChanges,
      });
    }

    return document;
  }

  private startSemanticTokensRefresh(
    document: OpenDocument,
    provider: SemanticTokensProviderInfo,
    timeoutMs: number,
  ): Promise<SemanticTokenOverlay> {
    const existing = this.semanticTokenRequests.get(document.uri);
    if (existing && existing.version === document.version && existing.timeoutMs === timeoutMs) {
      return existing.request;
    }

    let pending: SemanticTokenPendingRequest;
    const request = this.fetchSemanticTokens(document, provider, timeoutMs)
      .finally(() => {
        if (this.semanticTokenRequests.get(document.uri) === pending) {
          this.semanticTokenRequests.delete(document.uri);
        }
      });
    pending = { version: document.version, timeoutMs, request };
    this.semanticTokenRequests.set(document.uri, pending);
    return request;
  }

  private async fetchSemanticTokens(
    document: OpenDocument,
    provider: SemanticTokensProviderInfo,
    timeoutMs: number,
  ): Promise<SemanticTokenOverlay> {
    const requestedAt = Date.now();
    const requestedVersion = document.version;
    try {
      const result = normalizeSemanticTokensResult(await this.sendRequest(
        "textDocument/semanticTokens/full",
        { textDocument: { uri: document.uri } },
        timeoutMs,
      ));
      const receivedAt = Date.now();
      if (!result) throw new Error("semantic token response did not contain token data");

      const entry: SemanticTokenCacheEntry = {
        serverId: this.id,
        uri: document.uri,
        version: requestedVersion,
        tokens: decodeSemanticTokens(result.data, provider.legend),
        legend: provider.legend,
        resultId: result.resultId,
        requestedAt,
        receivedAt,
      };

      const currentVersion = this.documents.get(document.uri)?.version;
      const stale = currentVersion !== requestedVersion;
      if (!stale) this.semanticTokens.set(document.uri, entry);
      return semanticTokenOverlayFromCache(entry, stale ? "refreshing" : "ready", stale);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return {
        serverId: this.id,
        uri: document.uri,
        version: requestedVersion,
        state: "error",
        stale: false,
        tokens: [],
        legend: provider.legend,
        requestedAt,
        receivedAt: Date.now(),
        error: this.lastError,
      };
    }
  }

  private sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextRequestId++;
    const message: JsonRpcRequest = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.cancelRequest(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { method, resolve, reject, timeout });
      try {
        this.send(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    const message: JsonRpcNotification = params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    this.send(message);
  }

  private cancelRequest(id: number | string): void {
    try {
      this.notify("$/cancelRequest", { id });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private send(message: JsonRpcMessage): void {
    if (!this.process?.stdin.writable) throw new Error(`LSP process is not writable: ${this.id}`);
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    this.process.stdin.write(header + body, "utf8");
  }

  private handleData(chunk: Buffer): void {
    this.inputBuffer = Buffer.concat([this.inputBuffer, chunk]);

    while (true) {
      const headerEnd = this.inputBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;

      const header = this.inputBuffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        this.inputBuffer = this.inputBuffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = Number.parseInt(lengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.inputBuffer.length < bodyEnd) return;

      const body = this.inputBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.inputBuffer = this.inputBuffer.subarray(bodyEnd);

      try {
        this.handleMessage(JSON.parse(body) as JsonRpcMessage);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if ("id" in message && ("result" in message || "error" in message)) {
      if (message.id === null) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if ("id" in message && "method" in message) {
      this.handleServerRequest(message);
      return;
    }

    if ("method" in message) {
      if (message.method === "textDocument/publishDiagnostics") {
        this.handlePublishDiagnostics(message.params);
      }
    }
  }

  private handleServerRequest(message: JsonRpcRequest): void {
    let result: unknown = null;
    switch (message.method) {
      case "workspace/configuration":
        result = [];
        break;
      case "workspace/workspaceFolders":
        result = [{ uri: filePathToUri(this.root), name: path.basename(this.root) || this.root }];
        break;
      case "workspace/applyEdit":
        result = { applied: false, failureReason: "pi-code-feedback does not let language servers apply edits directly" };
        break;
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/showMessageRequest":
      case "window/workDoneProgress/create":
        result = null;
        break;
    }

    try {
      this.send({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private handlePublishDiagnostics(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const diagnostics = params as PublishDiagnosticsParams;
    if (typeof diagnostics.uri !== "string" || !Array.isArray(diagnostics.diagnostics)) return;

    const entry: DiagnosticEntry = {
      uri: diagnostics.uri,
      version: typeof diagnostics.version === "number" ? diagnostics.version : undefined,
      diagnostics: diagnostics.diagnostics,
      receivedAt: Date.now(),
    };
    this.diagnostics.set(diagnostics.uri, entry);
    this.lastDiagnosticsAt = entry.receivedAt;
    this.notifyDiagnosticWaiters(entry);
  }

  private waitForDiagnostics(uri: string, minVersion: number, touchedAt: number, timeoutMs: number, settleMs: number): Promise<boolean> {
    const existing = this.diagnostics.get(uri);
    if (existing && diagnosticsAreFresh(existing, minVersion, touchedAt)) {
      return settleDiagnostics(settleMs);
    }

    return new Promise((resolve) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;

      const waiter: DiagnosticWaiter = {
        minVersion,
        touchedAt,
        finish: (fresh) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          this.removeDiagnosticWaiter(uri, waiter);
          if (fresh) {
            void settleDiagnostics(settleMs).then(resolve);
          } else {
            resolve(false);
          }
        },
      };

      timeout = setTimeout(() => waiter.finish(false), Math.max(0, timeoutMs));
      timeout.unref?.();
      this.addDiagnosticWaiter(uri, waiter);

      const current = this.diagnostics.get(uri);
      if (current && diagnosticsAreFresh(current, minVersion, touchedAt)) {
        waiter.finish(true);
      }
    });
  }

  private addDiagnosticWaiter(uri: string, waiter: DiagnosticWaiter): void {
    const waiters = this.diagnosticWaiters.get(uri) ?? new Set<DiagnosticWaiter>();
    waiters.add(waiter);
    this.diagnosticWaiters.set(uri, waiters);
  }

  private removeDiagnosticWaiter(uri: string, waiter: DiagnosticWaiter): void {
    const waiters = this.diagnosticWaiters.get(uri);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) this.diagnosticWaiters.delete(uri);
  }

  private notifyDiagnosticWaiters(entry: DiagnosticEntry): void {
    const waiters = this.diagnosticWaiters.get(entry.uri);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (diagnosticsAreFresh(entry, waiter.minVersion, waiter.touchedAt)) {
        waiter.finish(true);
      }
    }
  }

  private finishDiagnosticWaiters(fresh: boolean): void {
    const waiters = [...this.diagnosticWaiters.values()].flatMap((entries) => [...entries]);
    for (const waiter of waiters) waiter.finish(fresh);
  }

  private normalizeDiagnostics(entry: DiagnosticEntry): LspDiagnostic[] {
    return entry.diagnostics.map((diagnostic) => ({
      uri: entry.uri,
      range: lspRangeToExternal(diagnostic.range),
      severity: normalizeSeverity(diagnostic.severity),
      message: typeof diagnostic.message === "string" ? diagnostic.message : "LSP diagnostic",
      source: typeof diagnostic.source === "string" ? diagnostic.source : undefined,
      code: typeof diagnostic.code === "string" || typeof diagnostic.code === "number" ? diagnostic.code : undefined,
      relatedInformation: normalizeRelatedInformation(diagnostic.relatedInformation),
      version: entry.version,
    }));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function diagnosticsAreFresh(entry: DiagnosticEntry, minVersion: number, touchedAt: number): boolean {
  if (typeof entry.version === "number") return entry.version >= minVersion;
  return entry.receivedAt >= touchedAt;
}

async function settleDiagnostics(settleMs: number): Promise<boolean> {
  if (settleMs > 0) await sleep(settleMs);
  return true;
}

function normalizeRelatedInformation(value: RawRelatedInformation[] | undefined): RelatedLocation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const related = value
    .map((entry): RelatedLocation | undefined => {
      const uri = entry.location?.uri;
      const range = entry.location?.range;
      if (typeof uri !== "string" || !range) return undefined;
      return {
        uri,
        range: lspRangeToExternal(range),
        message: typeof entry.message === "string" ? entry.message : undefined,
      };
    })
    .filter((entry): entry is RelatedLocation => entry !== undefined);
  return related.length > 0 ? related : undefined;
}

function normalizeSeverity(value: number | undefined): LspDiagnostic["severity"] {
  switch (value) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "information";
    case 4:
      return "hint";
    default:
      return "warning";
  }
}

function classifyServerLog(message: string): LspServerLog {
  return {
    level: inferServerLogLevel(message),
    message,
    at: Date.now(),
  };
}

function inferServerLogLevel(message: string): LspServerLogLevel {
  if (/\b(warn|warning)\b/i.test(message)) return "warning";
  if (/\b(error|fatal|panic)\b/i.test(message)) return "error";
  return "info";
}

function readServerCapabilities(initializeResult: unknown): unknown {
  if (!initializeResult || typeof initializeResult !== "object") return undefined;
  return (initializeResult as { capabilities?: unknown }).capabilities;
}

function semanticTokensProvider(capabilities: unknown): SemanticTokensProviderInfo | undefined {
  const provider = isRecord(capabilities) ? capabilities.semanticTokensProvider : undefined;
  if (!isRecord(provider)) return undefined;

  const legend = isRecord(provider.legend) ? provider.legend : undefined;
  const tokenTypes = stringArray(legend?.tokenTypes);
  if (tokenTypes.length === 0) return undefined;

  return {
    legend: {
      tokenTypes,
      tokenModifiers: stringArray(legend?.tokenModifiers),
    },
    full: provider.full === true || isRecord(provider.full),
  };
}

function semanticTokenOverlayFromCache(
  entry: SemanticTokenCacheEntry,
  state: SemanticTokenOverlay["state"],
  stale: boolean,
): SemanticTokenOverlay {
  return {
    serverId: entry.serverId,
    uri: entry.uri,
    version: entry.version,
    state,
    stale,
    tokens: entry.tokens,
    legend: entry.legend,
    resultId: entry.resultId,
    requestedAt: entry.requestedAt,
    receivedAt: entry.receivedAt,
  };
}

function normalizeSemanticTokensResult(value: unknown): RawSemanticTokensResult | undefined {
  if (!isRecord(value)) return undefined;
  const data = Array.isArray(value.data)
    ? value.data.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
    : undefined;
  if (!data) return undefined;

  return {
    resultId: typeof value.resultId === "string" ? value.resultId : undefined,
    data,
  };
}

function decodeSemanticTokens(data: number[], legend: SemanticTokenLegend): SemanticToken[] {
  const tokens: SemanticToken[] = [];
  let line = 0;
  let character = 0;

  for (let index = 0; index + 4 < data.length; index += 5) {
    const deltaLine = Math.max(0, Math.trunc(data[index]!));
    const deltaStart = Math.max(0, Math.trunc(data[index + 1]!));
    const length = Math.max(0, Math.trunc(data[index + 2]!));
    const tokenTypeIndex = Math.max(0, Math.trunc(data[index + 3]!));
    const modifierBits = Math.max(0, Math.trunc(data[index + 4]!));

    line += deltaLine;
    character = deltaLine === 0 ? character + deltaStart : deltaStart;
    if (length === 0) continue;

    tokens.push({
      line,
      character,
      length,
      type: legend.tokenTypes[tokenTypeIndex] ?? `token(${tokenTypeIndex})`,
      modifiers: semanticTokenModifiers(modifierBits, legend.tokenModifiers),
    });
  }

  return tokens;
}

function semanticTokenModifiers(bits: number, tokenModifiers: string[]): string[] {
  const modifiers: string[] = [];
  for (let index = 0; index < tokenModifiers.length; index += 1) {
    if ((bits & (1 << index)) !== 0) modifiers.push(tokenModifiers[index]!);
  }
  return modifiers;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function textDocumentChangeSyncKind(capabilities: unknown): TextDocumentSyncKind {
  const sync = isRecord(capabilities) ? capabilities.textDocumentSync : undefined;
  if (typeof sync === "number") return normalizeTextDocumentSyncKind(sync);
  if (isRecord(sync) && typeof sync.change === "number") return normalizeTextDocumentSyncKind(sync.change);
  return TEXT_DOCUMENT_SYNC_FULL;
}

function textDocumentDidSaveParams(uri: string, content: string, capabilities: unknown): Record<string, unknown> {
  const params: Record<string, unknown> = { textDocument: { uri } };
  if (textDocumentSaveIncludesText(capabilities)) params.text = content;
  return params;
}

function textDocumentSaveIncludesText(capabilities: unknown): boolean {
  const sync = isRecord(capabilities) ? capabilities.textDocumentSync : undefined;
  if (!isRecord(sync)) return false;
  return isRecord(sync.save) && sync.save.includeText === true;
}

function normalizeTextDocumentSyncKind(value: number): TextDocumentSyncKind {
  switch (value) {
    case TEXT_DOCUMENT_SYNC_NONE:
      return TEXT_DOCUMENT_SYNC_NONE;
    case TEXT_DOCUMENT_SYNC_INCREMENTAL:
      return TEXT_DOCUMENT_SYNC_INCREMENTAL;
    default:
      return TEXT_DOCUMENT_SYNC_FULL;
  }
}

function incrementalContentChange(oldText: string, newText: string): TextDocumentContentChange {
  const prefixLength = commonPrefixLength(oldText, newText);
  const suffixLength = commonSuffixLength(oldText, newText, prefixLength);
  const oldEnd = oldText.length - suffixLength;
  const newEnd = newText.length - suffixLength;
  return {
    range: {
      start: positionAt(oldText, prefixLength),
      end: positionAt(oldText, oldEnd),
    },
    rangeLength: oldEnd - prefixLength,
    text: newText.slice(prefixLength, newEnd),
  };
}

function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return avoidsTrailingHighSurrogate(left, right, index) ? index : index - 1;
}

function commonSuffixLength(left: string, right: string, prefixLength: number): number {
  const max = Math.min(left.length, right.length) - prefixLength;
  let length = 0;
  while (
    length < max &&
    left.charCodeAt(left.length - length - 1) === right.charCodeAt(right.length - length - 1)
  ) {
    length += 1;
  }
  return length;
}

function avoidsTrailingHighSurrogate(left: string, right: string, index: number): boolean {
  if (index <= 0) return true;
  const previous = left.charCodeAt(index - 1);
  if (!isHighSurrogate(previous)) return true;
  return !isLowSurrogate(left.charCodeAt(index)) && !isLowSurrogate(right.charCodeAt(index));
}

function positionAt(text: string, offset: number): { line: number; character: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < clamped; index++) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: clamped - lineStart };
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

