import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { createDiagnosticSnapshot } from "../diagnostics/snapshots.ts";
import { mergeProcessEnv } from "../language-environments.ts";
import type { DiagnosticRefreshResult, DiagnosticSnapshot, LspClientState, LspClientStatus, LspDiagnostic, LspDiagnosticOutcome, LspServerLog, LspServerLogLevel, RelatedLocation } from "../types.ts";
import { abortError, isCancellation, throwIfAborted, waitWithSignal } from "./cancellation.ts";
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
  signal?: AbortSignal;
  onAbort?: () => void;
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

interface TextDocumentContentChange {
  text: string;
  range?: LspRange;
  rangeLength?: number;
}

const TEXT_DOCUMENT_SYNC_NONE = 0;
const TEXT_DOCUMENT_SYNC_FULL = 1;
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2;
let nextLspClientSessionId = 1;

type TextDocumentSyncKind = typeof TEXT_DOCUMENT_SYNC_NONE | typeof TEXT_DOCUMENT_SYNC_FULL | typeof TEXT_DOCUMENT_SYNC_INCREMENTAL;

export interface TouchDocumentOptions {
  timeoutMs: number;
  settleMs: number;
  snapshotScope?: DiagnosticSnapshotScope;
  signal?: AbortSignal;
}

export type DiagnosticSnapshotScope = "file" | "workspace";

const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
const PROCESS_KILL_GRACE_MS = 750;

export interface LspClientOptions {
  initializeTimeoutMs?: number;
}

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
  private capabilities: unknown;
  private lastDiagnosticsAt?: number;
  private lastDiagnosticDurationMs?: number;
  private lastDiagnosticOutcome?: LspDiagnosticOutcome;
  private lastError?: string;
  private lastServerLog?: LspServerLog;
  private sessionId?: string;
  private launchGeneration = 0;
  private initializeTimeoutMs: number;

  constructor(definition: LanguageServerDefinition, root: string, options: LspClientOptions = {}) {
    this.definition = definition;
    this.id = definition.id;
    this.root = path.resolve(root);
    this.initializeTimeoutMs = Math.max(1, options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS);
  }

  async touchDocumentDetailed(filePath: string, content: string, options: TouchDocumentOptions): Promise<DiagnosticRefreshResult> {
    await this.ensureStarted(options.signal);
    throwIfAborted(options.signal);

    const touchedAt = Date.now();
    const document = this.syncDocument(filePath, content);

    this.notify("textDocument/didSave", textDocumentDidSaveParams(document.uri, content, this.capabilities));

    let fresh: boolean;
    try {
      fresh = await this.waitForDiagnostics(document.uri, document.version, touchedAt, options.timeoutMs, options.settleMs, options.signal);
    } catch (error) {
      if (isCancellation(error, options.signal)) {
        this.lastDiagnosticDurationMs = Date.now() - touchedAt;
        this.lastDiagnosticOutcome = "cancelled";
      }
      throw error;
    }
    const completedAt = Date.now();
    this.lastDiagnosticDurationMs = completedAt - touchedAt;
    this.lastDiagnosticOutcome = fresh ? "fresh" : "timeout";
    return {
      snapshot: this.snapshotForScope(document.uri, options.snapshotScope),
      fresh,
      timedOut: !fresh,
      requestedAt: touchedAt,
      completedAt,
    };
  }

  async ensureDocument(filePath: string, content: string, signal?: AbortSignal): Promise<void> {
    await this.ensureStarted(signal);
    throwIfAborted(signal);
    this.syncDocument(filePath, content);
  }

  async start(signal?: AbortSignal): Promise<void> {
    await this.ensureStarted(signal);
  }

  snapshot(): DiagnosticSnapshot {
    const diagnostics = [...this.diagnostics.values()].flatMap((entry) => this.normalizeDiagnostics(entry));
    return createDiagnosticSnapshot(diagnostics);
  }

  snapshotForUri(uri: string): DiagnosticSnapshot {
    return createDiagnosticSnapshot(this.diagnosticsForUri(uri));
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
  }

  async request(method: string, params?: unknown, timeoutMs = 10_000, signal?: AbortSignal): Promise<unknown> {
    await this.ensureStarted(signal);
    return this.sendRequest(method, params, timeoutMs, signal);
  }

  async requestForDocument(filePath: string, content: string, method: string, params: Record<string, unknown>, timeoutMs = 10_000, signal?: AbortSignal): Promise<unknown> {
    await this.ensureDocument(filePath, content, signal);
    return this.sendRequest(method, params, timeoutMs, signal);
  }

  getCapabilities(): unknown {
    return this.capabilities;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  documentVersion(filePath: string): number | undefined {
    return this.documents.get(filePathToUri(filePath))?.version;
  }

  canResolveCodeActions(): boolean {
    return codeActionResolveProvider(this.capabilities);
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
      lastDiagnosticOutcome: this.lastDiagnosticOutcome,
      lastError: this.lastError,
      lastServerLog: this.lastServerLog,
      environment: this.definition.environment?.description,
    };
  }

  async shutdown(signal?: AbortSignal): Promise<void> {
    this.finishDiagnosticWaiters(false);
    const child = this.process;
    const generation = this.launchGeneration;
    if (!child) {
      this.resetStoppedState();
      return;
    }

    if (this.state === "ready") {
      try {
        await this.sendRequest("shutdown", undefined, 1500, signal);
        if (this.isActiveLaunch(child, generation)) this.notify("exit");
      } catch {
        // Fall through to killing the process.
      }
    }

    if (this.isActiveLaunch(child, generation)) this.detachActiveProcess(child);
    this.rejectPending(new Error("LSP client stopped"));
    this.resetStoppedState();
    terminateProcess(child);
  }

  private async ensureStarted(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.state === "ready") return;
    if (this.initializePromise) return waitWithSignal(this.initializePromise, signal);

    this.state = "starting";
    const attempt = this.startAndInitialize(signal);
    this.initializePromise = attempt;
    attempt.then(
      () => {
        if (this.initializePromise === attempt) this.initializePromise = undefined;
      },
      () => {
        if (this.initializePromise === attempt) this.initializePromise = undefined;
      },
    );
    return attempt;
  }

  private async startAndInitialize(signal?: AbortSignal): Promise<void> {
    const generation = ++this.launchGeneration;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.definition.command, this.definition.args, {
        cwd: this.root,
        env: mergeProcessEnv(this.definition.env),
        stdio: "pipe",
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.state = "failed";
      this.sessionId = undefined;
      this.lastError = failure.message;
      this.clearServerState();
      this.finishDiagnosticWaiters(false);
      throw failure;
    }
    this.process = child;
    this.inputBuffer = Buffer.alloc(0);

    child.stdout.on("data", (chunk: Buffer) => {
      if (this.isActiveLaunch(child, generation)) this.handleData(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!this.isActiveLaunch(child, generation)) return;
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) this.lastServerLog = classifyServerLog(text.slice(-1000));
    });
    child.on("error", (error) => {
      if (!this.isActiveLaunch(child, generation)) return;
      this.failActiveLaunch(child, error);
    });
    child.on("exit", (code, signal) => {
      if (!this.isActiveLaunch(child, generation)) return;
      const message = code !== 0 || signal
        ? `process exited code=${code ?? "null"} signal=${signal ?? "null"}`
        : "LSP process exited";
      this.lastError = code !== 0 || signal ? message : this.lastError;
      this.detachActiveProcess(child);
      this.state = code === 0 ? "stopped" : "failed";
      this.sessionId = undefined;
      this.clearServerState();
      this.rejectPending(new Error(message));
      this.finishDiagnosticWaiters(false);
    });

    try {
      const initializeResult = await this.sendRequest("initialize", this.initializeParams(), this.initializeTimeoutMs, signal);
      if (!this.isActiveLaunch(child, generation)) throw new Error(`LSP initialization was superseded: ${this.id}`);
      this.capabilities = readServerCapabilities(initializeResult);
      this.notify("initialized", {});
      this.state = "ready";
      this.sessionId = createLspClientSessionId(this.id);
      this.lastError = undefined;
    } catch (error) {
      if (this.isActiveLaunch(child, generation)) {
        this.failActiveLaunch(child, error);
      }
      throw error;
    }
  }

  private isActiveLaunch(child: ChildProcessWithoutNullStreams, generation: number): boolean {
    return this.process === child && this.launchGeneration === generation;
  }

  private failActiveLaunch(child: ChildProcessWithoutNullStreams, error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.lastError = failure.message;
    this.state = "failed";
    this.sessionId = undefined;
    this.detachActiveProcess(child);
    this.clearServerState();
    this.rejectPending(failure);
    this.finishDiagnosticWaiters(false);
    terminateProcess(child);
  }

  private detachActiveProcess(child: ChildProcessWithoutNullStreams): void {
    if (this.process !== child) return;
    this.process = undefined;
    this.inputBuffer = Buffer.alloc(0);
  }

  private resetStoppedState(): void {
    this.state = "stopped";
    this.sessionId = undefined;
    this.initializePromise = undefined;
    this.clearServerState();
  }

  private clearServerState(): void {
    this.capabilities = undefined;
    this.documents.clear();
    this.diagnostics.clear();
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
        },
        workspace: {
          applyEdit: false,
          workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] },
          symbol: { resolveSupport: { properties: ["location.range"] } },
          configuration: true,
          workspaceFolders: true,
        },
        window: { workDoneProgress: false },
      },
      initializationOptions: this.definition.initializationOptions ?? {},
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

  private sendRequest(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    const id = this.nextRequestId++;
    const message: JsonRpcRequest = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      let pending: PendingRequest;
      const timeout = setTimeout(() => {
        if (!this.removePending(id, pending)) return;
        this.cancelRequest(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);
      timeout.unref?.();
      const onAbort = signal ? () => {
        if (!this.removePending(id, pending)) return;
        this.cancelRequest(id);
        reject(abortError(signal));
      } : undefined;
      pending = { method, resolve, reject, timeout, signal, onAbort };
      this.pending.set(id, pending);
      if (onAbort) signal!.addEventListener("abort", onAbort, { once: true });
      try {
        this.send(message);
      } catch (error) {
        this.removePending(id, pending);
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
      this.removePending(message.id, pending);
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
        result = this.workspaceConfiguration(message.params);
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

  private workspaceConfiguration(params: unknown): unknown[] {
    const items = isRecord(params) && Array.isArray(params.items) ? params.items : [];
    const config = this.definition.workspaceConfiguration;
    return items.map((item) => configurationForItem(config, item));
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

  private waitForDiagnostics(
    uri: string,
    minVersion: number,
    touchedAt: number,
    timeoutMs: number,
    settleMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    throwIfAborted(signal);
    const existing = this.diagnostics.get(uri);
    if (existing && diagnosticsAreFresh(existing, minVersion, touchedAt)) {
      return settleDiagnostics(settleMs, signal);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        this.removeDiagnosticWaiter(uri, waiter);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(abortError(signal));
      };

      const waiter: DiagnosticWaiter = {
        minVersion,
        touchedAt,
        finish: (fresh) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (fresh) {
            void settleDiagnostics(settleMs, signal).then(resolve, reject);
          } else {
            resolve(false);
          }
        },
      };

      timeout = setTimeout(() => waiter.finish(false), Math.max(0, timeoutMs));
      timeout.unref?.();
      this.addDiagnosticWaiter(uri, waiter);
      signal?.addEventListener("abort", onAbort, { once: true });

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
    return entry.diagnostics.flatMap((diagnostic) => {
      const range = lspRangeToExternal(diagnostic?.range);
      if (!range) return [];
      return [{
        uri: entry.uri,
        range,
        severity: normalizeSeverity(diagnostic.severity),
        message: typeof diagnostic.message === "string" ? diagnostic.message : "LSP diagnostic",
        source: typeof diagnostic.source === "string" ? diagnostic.source : undefined,
        code: typeof diagnostic.code === "string" || typeof diagnostic.code === "number" ? diagnostic.code : undefined,
        relatedInformation: normalizeRelatedInformation(diagnostic.relatedInformation),
        version: entry.version,
      }];
    });
  }

  private snapshotForScope(uri: string, scope: DiagnosticSnapshotScope | undefined): DiagnosticSnapshot {
    return scope === "workspace" ? this.snapshot() : this.snapshotForUri(uri);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.removePending(id, pending);
      pending.reject(error);
    }
  }

  private removePending(id: number | string, pending: PendingRequest): boolean {
    if (this.pending.get(id) !== pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    return true;
  }
}

function diagnosticsAreFresh(entry: DiagnosticEntry, minVersion: number, touchedAt: number): boolean {
  if (typeof entry.version === "number") return entry.version >= minVersion;
  return entry.receivedAt >= touchedAt;
}

async function settleDiagnostics(settleMs: number, signal?: AbortSignal): Promise<boolean> {
  if (settleMs > 0) await waitWithSignal(sleep(settleMs), signal);
  else throwIfAborted(signal);
  return true;
}

function normalizeRelatedInformation(value: unknown): RelatedLocation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const related = value
    .map((entry): RelatedLocation | undefined => {
      if (!isRecord(entry) || !isRecord(entry.location)) return undefined;
      const uri = entry.location.uri;
      const range = lspRangeToExternal(entry.location.range);
      if (typeof uri !== "string" || !range) return undefined;
      return {
        uri,
        range,
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

function codeActionResolveProvider(capabilities: unknown): boolean {
  const provider = isRecord(capabilities) ? capabilities.codeActionProvider : undefined;
  return isRecord(provider) && provider.resolveProvider === true;
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

function configurationForItem(config: Record<string, unknown> | undefined, item: unknown): unknown {
  if (!config) return {};
  if (!isRecord(item) || typeof item.section !== "string" || item.section.length === 0) return config;

  const exact = config[item.section];
  if (exact !== undefined) return exact;

  const nested = item.section.split(".").reduce<unknown>((current, part) => {
    if (!isRecord(current)) return undefined;
    return current[part];
  }, config);
  return nested ?? {};
}

function createLspClientSessionId(serverId: string): string {
  const sequence = nextLspClientSessionId++;
  return `${serverId}:${sequence.toString(36)}`;
}

function terminateProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGTERM");
  const forceKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, PROCESS_KILL_GRACE_MS);
  forceKill.unref?.();
  child.once("exit", () => clearTimeout(forceKill));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

