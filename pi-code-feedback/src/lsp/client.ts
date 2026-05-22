import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { createDiagnosticSnapshot } from "../diagnostics/snapshots.ts";
import type { DiagnosticRefreshResult, DiagnosticSnapshot, LspClientState, LspClientStatus, LspDiagnostic, LspServerLog, LspServerLogLevel, RelatedLocation } from "../types.ts";
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

export interface TouchDocumentOptions {
  timeoutMs: number;
  settleMs: number;
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

    const uri = filePathToUri(filePath);
    const touchedAt = Date.now();
    const document = this.documents.get(uri);
    const languageId = this.definition.languageId(filePath);
    const version = (document?.version ?? 0) + 1;

    if (!document) {
      this.documents.set(uri, { uri, filePath, languageId, version, content });
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId,
          version,
          text: content,
        },
      });
    } else {
      document.version = version;
      document.content = content;
      document.languageId = languageId;
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    }

    this.notify("textDocument/didSave", {
      textDocument: { uri },
      text: content,
    });

    const fresh = await this.waitForDiagnostics(uri, version, touchedAt, options.timeoutMs, options.settleMs);
    return {
      snapshot: this.snapshot(),
      fresh,
      timedOut: !fresh,
      requestedAt: touchedAt,
      completedAt: Date.now(),
    };
  }

  async ensureDocument(filePath: string, content: string): Promise<void> {
    await this.touchDocument(filePath, content, { timeoutMs: 1, settleMs: 0 });
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
  }

  async request(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
    await this.ensureStarted();
    return this.sendRequest(method, params, timeoutMs);
  }

  async requestForDocument(filePath: string, content: string, method: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    await this.ensureDocument(filePath, content);
    return this.request(method, params, timeoutMs);
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

  private sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextRequestId++;
    const message: JsonRpcRequest = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

