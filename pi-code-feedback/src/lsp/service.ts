import * as path from "node:path";
import { createDiagnosticSnapshot } from "../diagnostics/snapshots.ts";
import { readUtf8IfExists } from "../fs.ts";
import { LSP_RESULT_SERVER_ID_KEY, type DiagnosticRefreshResult, type DiagnosticSnapshot, type LspDiagnostic, type LspServiceStatus, type LspUnavailableServer } from "../types.ts";
import { LspClient } from "./client.ts";
import { externalPositionToLsp, filePathToUri, oneLineLspRange, type LspPosition } from "./positions.ts";
import { resolveLanguageServer, resolveLanguageServers, type LanguageServerDefinition } from "./servers.ts";

export interface LspServiceOptions {
  projectRoot: string;
  serverOverrides?: Record<string, unknown>;
  idleTimeoutMs: number;
}

export interface DiagnosticsForFileOptions {
  timeoutMs: number;
  settleMs: number;
}

const CODE_ACTION_DIAGNOSTIC_TIMEOUT_MS = 1200;

interface ClientRequestResult {
  client: LspClient;
  result?: unknown;
  error?: string;
}

export class LspService {
  private projectRoot: string;
  private serverOverrides: Record<string, unknown>;
  private idleTimeoutMs: number;
  private clients = new Map<string, LspClient>();
  private unavailableServers = new Map<string, LspUnavailableServer>();
  private idleTimer?: NodeJS.Timeout;

  constructor(options: LspServiceOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.serverOverrides = options.serverOverrides ?? {};
    this.idleTimeoutMs = options.idleTimeoutMs;
  }

  configure(options: LspServiceOptions): void {
    this.projectRoot = path.resolve(options.projectRoot);
    this.serverOverrides = options.serverOverrides ?? {};
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.armIdleTimer();
  }

  async diagnosticsForFile(filePath: string, content: string | undefined, options: DiagnosticsForFileOptions): Promise<DiagnosticSnapshot | undefined> {
    return (await this.diagnosticsForFileDetailed(filePath, content, options))?.snapshot;
  }

  async diagnosticsForFileDetailed(filePath: string, content: string | undefined, options: DiagnosticsForFileOptions): Promise<DiagnosticRefreshResult | undefined> {
    const resolved = path.resolve(this.projectRoot, filePath);
    const clients = this.getOrCreateClients(resolved);
    if (clients.length === 0) return undefined;

    const finalContent = content ?? readUtf8IfExists(resolved);
    if (finalContent === undefined) {
      const now = Date.now();
      return {
        snapshot: mergeSnapshots(clients.map((client) => client.snapshot())),
        fresh: true,
        timedOut: false,
        requestedAt: now,
        completedAt: now,
      };
    }

    const results = await Promise.all(clients.map(async (client) => {
      try {
        return await client.touchDocumentDetailed(resolved, finalContent, options);
      } catch (error) {
        this.markClientInstanceError(resolved, client, error);
        return undefined;
      }
    }));

    const successful = results.filter((result): result is DiagnosticRefreshResult => result !== undefined);
    if (successful.length === 0) return undefined;

    this.armIdleTimer();
    return {
      snapshot: mergeSnapshots(successful.map((result) => result.snapshot)),
      fresh: successful.every((result) => result.fresh),
      timedOut: successful.some((result) => result.timedOut),
      requestedAt: Math.min(...successful.map((result) => result.requestedAt)),
      completedAt: Math.max(...successful.map((result) => result.completedAt)),
    };
  }

  cachedDiagnostics(pathOrAll?: string): DiagnosticSnapshot {
    const snapshot = this.snapshotAll();
    if (!pathOrAll || pathOrAll === "all") return snapshot;

    const resolved = path.resolve(this.projectRoot, pathOrAll);
    const uri = filePathToUri(resolved);
    return createDiagnosticSnapshot(snapshot.byUri.get(uri) ?? []);
  }

  cachedDiagnosticsIfKnown(filePath: string): DiagnosticSnapshot | undefined {
    const resolved = path.resolve(this.projectRoot, filePath);
    const uri = filePathToUri(resolved);
    const clients = this.cachedClientsForFile(resolved);
    if (!clients) return undefined;

    const diagnostics = clients.flatMap((client) => client.diagnosticsForUri(uri));
    return createDiagnosticSnapshot(diagnostics);
  }

  prewarm(filePath: string): void {
    const resolved = path.resolve(this.projectRoot, filePath);
    const clients = this.getOrCreateClients(resolved);
    if (clients.length === 0) return;

    void Promise.all(clients.map(async (client) => {
      try {
        await client.start();
      } catch (error) {
        this.markClientInstanceError(resolved, client, error);
      }
    })).finally(() => this.armIdleTimer());
  }

  forgetFile(filePath: string): void {
    const resolved = path.resolve(this.projectRoot, filePath);
    for (const client of this.clients.values()) client.forgetDocument(resolved);
  }

  snapshotAll(): DiagnosticSnapshot {
    const diagnostics = [...this.clients.values()].flatMap((client) => [...client.snapshot().byUri.values()].flat());
    return createDiagnosticSnapshot(diagnostics);
  }

  async capabilities(filePath?: string): Promise<unknown> {
    if (!filePath) {
      return this.getStatus();
    }
    const clients = this.getOrCreateClients(path.resolve(this.projectRoot, filePath));
    if (clients.length === 0) return undefined;

    const servers = await Promise.all(clients.map(async (client) => {
      try {
        await client.start();
        return { serverId: client.id, capabilities: client.getCapabilities() };
      } catch (error) {
        return { serverId: client.id, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    return servers.length === 1 && !servers[0].error ? servers[0].capabilities : { servers };
  }

  async hover(filePath: string, line: unknown, character: unknown): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("hover requires 1-based line and character");
    const results = await this.documentRequests(filePath, "textDocument/hover", { position });
    return results.map((result) => result.result).find(hasHoverContent);
  }

  async definition(filePath: string, line: unknown, character: unknown): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("definition requires 1-based line and character");
    return mergeArrayLikeResults(await this.documentRequests(filePath, "textDocument/definition", { position }));
  }

  async references(filePath: string, line: unknown, character: unknown): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("references requires 1-based line and character");
    return mergeArrayLikeResults(await this.documentRequests(filePath, "textDocument/references", { position, context: { includeDeclaration: true } }));
  }

  async implementation(filePath: string, line: unknown, character: unknown): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("implementation requires 1-based line and character");
    return mergeArrayLikeResults(await this.documentRequests(filePath, "textDocument/implementation", { position }));
  }

  async typeDefinition(filePath: string, line: unknown, character: unknown): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("type_definition requires 1-based line and character");
    return mergeArrayLikeResults(await this.documentRequests(filePath, "textDocument/typeDefinition", { position }));
  }

  async documentSymbols(filePath: string): Promise<unknown> {
    return mergeArrayResults(await this.documentRequests(filePath, "textDocument/documentSymbol", {}));
  }

  async workspaceSymbols(query: unknown, filePath?: string): Promise<unknown> {
    if (typeof query !== "string") throw new Error("workspace_symbols requires query");
    const clients = filePath ? this.getOrCreateClients(path.resolve(this.projectRoot, filePath)) : this.readyOrAnyClients();
    if (clients.length === 0) throw new Error("No active LSP client. Open a file with lsp diagnostics first, or pass path to choose a language server.");
    return mergeArrayResults(await this.clientRequests(clients, "workspace/symbol", { query }));
  }

  async codeActions(filePath: string, line: unknown, character: unknown): Promise<unknown> {
    const position = externalPositionToLsp(line, character) ?? { line: 0, character: 0 };
    const range = oneLineLspRange(position);
    const resolved = path.resolve(this.projectRoot, filePath);
    const content = readUtf8IfExists(resolved);
    if (content === undefined) throw new Error(`Cannot read file for LSP request: ${resolved}`);

    await this.diagnosticsForFileDetailed(resolved, content, {
      timeoutMs: CODE_ACTION_DIAGNOSTIC_TIMEOUT_MS,
      settleMs: 0,
    }).catch(() => undefined);

    const clients = this.getOrCreateClients(resolved);
    if (clients.length === 0) throw new Error(`No language server configured for ${resolved}`);

    const uri = filePathToUri(resolved);
    const results = await this.runClientRequests(clients, "textDocument/codeAction", (client) => {
      const diagnostics = client.diagnosticsForUri(uri)
        .filter((diagnostic) => diagnosticOverlapsLspRange(diagnostic, range))
        .map(toCodeActionDiagnostic);
      return client.requestForDocument(resolved, content, "textDocument/codeAction", {
        textDocument: { uri },
        range,
        context: { diagnostics },
      });
    });
    return this.resolveAndMergeCodeActions(results);
  }

  async rename(filePath: string, line: unknown, character: unknown, newName: unknown): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("rename requires 1-based line and character");
    if (typeof newName !== "string" || newName.length === 0) throw new Error("rename requires newName");
    return this.documentRequest(filePath, "textDocument/rename", { position, newName });
  }

  async rawRequest(filePath: string | undefined, method: unknown, params: unknown): Promise<unknown> {
    if (typeof method !== "string" || method.length === 0) throw new Error("request action requires request method");
    const client = filePath ? this.getOrCreateClient(path.resolve(this.projectRoot, filePath)) : this.firstReadyOrAnyClient();
    if (!client) throw new Error("No LSP client available for raw request");
    return client.request(method, params);
  }

  getStatus(): LspServiceStatus {
    const clients = [...this.clients.values()].map((client) => client.getStatus());
    return {
      activeClients: clients.filter((client) => client.state === "ready" || client.state === "starting").length,
      clients,
      unavailableServers: [...this.unavailableServers.values()],
    };
  }

  async restart(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.unavailableServers.clear();
    for (const client of clients) {
      await client.shutdown().catch(() => undefined);
    }
    this.armIdleTimer();
  }

  async shutdownAll(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.unavailableServers.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    for (const client of clients) {
      await client.shutdown().catch(() => undefined);
    }
  }

  private async documentRequest(filePath: string, method: string, extraParams: Record<string, unknown>): Promise<unknown> {
    const resolved = path.resolve(this.projectRoot, filePath);
    const content = readUtf8IfExists(resolved);
    if (content === undefined) throw new Error(`Cannot read file for LSP request: ${resolved}`);

    const client = this.getOrCreateClient(resolved);
    if (!client) throw new Error(`No language server configured for ${resolved}`);

    const uri = filePathToUri(resolved);
    const params = {
      textDocument: { uri },
      ...extraParams,
    };
    const result = await client.requestForDocument(resolved, content, method, params);
    this.armIdleTimer();
    return result;
  }

  private async documentRequests(filePath: string, method: string, extraParams: Record<string, unknown>): Promise<ClientRequestResult[]> {
    const resolved = path.resolve(this.projectRoot, filePath);
    const content = readUtf8IfExists(resolved);
    if (content === undefined) throw new Error(`Cannot read file for LSP request: ${resolved}`);

    const clients = this.getOrCreateClients(resolved);
    if (clients.length === 0) throw new Error(`No language server configured for ${resolved}`);

    const uri = filePathToUri(resolved);
    const params = {
      textDocument: { uri },
      ...extraParams,
    };
    return this.runClientRequests(clients, method, (client) => client.requestForDocument(resolved, content, method, params));
  }

  private async clientRequests(clients: LspClient[], method: string, params: unknown): Promise<ClientRequestResult[]> {
    return this.runClientRequests(clients, method, (client) => client.request(method, params));
  }

  private async runClientRequests(clients: LspClient[], method: string, run: (client: LspClient) => Promise<unknown>): Promise<ClientRequestResult[]> {
    const results = await Promise.all(clients.map(async (client): Promise<ClientRequestResult> => {
      try {
        return { client, result: await run(client) };
      } catch (error) {
        return { client, error: error instanceof Error ? error.message : String(error) };
      }
    }));

    if (!results.some((result) => result.error === undefined)) {
      throw new Error(`All language servers failed ${method}: ${results.map((result) => `${result.client.id}: ${result.error ?? "unknown error"}`).join("; ")}`);
    }

    this.armIdleTimer();
    return results;
  }

  private async resolveAndMergeCodeActions(results: ClientRequestResult[]): Promise<unknown[]> {
    const actions = await Promise.all(results.flatMap((result) => {
      if (!Array.isArray(result.result)) return [];
      return result.result.map(async (action) => {
        const resolvedAction = await this.resolveCodeActionIfNeeded(result.client, action);
        return decorateCodeAction(result.client, resolvedAction);
      });
    }));
    this.armIdleTimer();
    return actions;
  }

  private async resolveCodeActionIfNeeded(client: LspClient, action: unknown): Promise<unknown> {
    if (!isRecord(action) || action.edit !== undefined) return action;
    try {
      return await client.request("codeAction/resolve", action);
    } catch {
      return action;
    }
  }

  private getOrCreateClient(filePath: string): LspClient | undefined {
    const resolved = path.resolve(filePath);
    const resolvedServer = resolveLanguageServer(resolved, this.serverOverrides, this.projectRoot);
    if (!resolvedServer) return undefined;

    if (!resolvedServer.available) {
      this.unavailableServers.set(resolvedServer.definition.id, {
        id: resolvedServer.definition.id,
        command: resolvedServer.definition.command,
        filePath: resolved,
        reason: resolvedServer.unavailableReason ?? "unavailable",
      });
      return undefined;
    }

    const root = this.projectRoot;
    const key = clientKey(root, resolvedServer.definition);
    let client = this.clients.get(key);
    if (!client) {
      client = new LspClient(resolvedServer.definition, root);
      this.clients.set(key, client);
    }
    return client;
  }

  private getOrCreateClients(filePath: string): LspClient[] {
    const resolved = path.resolve(filePath);
    const clients: LspClient[] = [];

    for (const resolvedServer of resolveLanguageServers(resolved, this.serverOverrides, this.projectRoot)) {
      if (!resolvedServer.available) {
        this.unavailableServers.set(resolvedServer.definition.id, {
          id: resolvedServer.definition.id,
          command: resolvedServer.definition.command,
          filePath: resolved,
          reason: resolvedServer.unavailableReason ?? "unavailable",
        });
        continue;
      }

      const root = this.projectRoot;
      const key = clientKey(root, resolvedServer.definition);
      let client = this.clients.get(key);
      if (!client) {
        client = new LspClient(resolvedServer.definition, root);
        this.clients.set(key, client);
      }
      clients.push(client);
    }

    return clients;
  }

  private cachedClientsForFile(filePath: string): LspClient[] | undefined {
    const resolved = path.resolve(filePath);
    const uri = filePathToUri(resolved);
    const clients: LspClient[] = [];

    for (const resolvedServer of resolveLanguageServers(resolved, this.serverOverrides, this.projectRoot)) {
      if (!resolvedServer.available) continue;
      const key = clientKey(this.projectRoot, resolvedServer.definition);
      const client = this.clients.get(key);
      if (!client || !client.hasDiagnosticsForUri(uri)) return undefined;
      clients.push(client);
    }

    return clients.length > 0 ? clients : undefined;
  }

  private firstReadyOrAnyClient(): LspClient | undefined {
    return [...this.clients.values()].find((client) => client.getStatus().state === "ready") ?? this.clients.values().next().value;
  }

  private readyOrAnyClients(): LspClient[] {
    const clients = [...this.clients.values()];
    const ready = clients.filter((client) => client.getStatus().state === "ready");
    return ready.length > 0 ? ready : clients;
  }

  private markClientInstanceError(filePath: string, client: LspClient, error: unknown): void {
    const status = client.getStatus();
    this.unavailableServers.set(status.id, {
      id: status.id,
      command: status.command,
      filePath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.idleTimeoutMs <= 0 || this.clients.size === 0) return;
    this.idleTimer = setTimeout(() => {
      void this.shutdownAll();
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }
}

function mergeSnapshots(snapshots: DiagnosticSnapshot[]): DiagnosticSnapshot {
  const diagnostics = snapshots.flatMap((snapshot) => [...snapshot.byUri.values()].flat());
  return createDiagnosticSnapshot(diagnostics);
}

function mergeArrayResults(results: ClientRequestResult[]): unknown[] {
  return dedupeResults(results.flatMap((result) => (Array.isArray(result.result) ? result.result : [])));
}

function mergeArrayLikeResults(results: ClientRequestResult[]): unknown[] {
  return dedupeResults(results.flatMap((result) => {
    if (Array.isArray(result.result)) return result.result;
    return result.result === undefined || result.result === null ? [] : [result.result];
  }));
}

function toCodeActionDiagnostic(diagnostic: LspDiagnostic): Record<string, unknown> {
  return {
    range: externalRangeToLsp(diagnostic.range),
    severity: severityToLspNumber(diagnostic.severity),
    code: diagnostic.code,
    source: diagnostic.source,
    message: diagnostic.message,
    relatedInformation: diagnostic.relatedInformation?.map((related) => ({
      location: {
        uri: related.uri,
        range: externalRangeToLsp(related.range),
      },
      message: related.message ?? "",
    })),
  };
}

function decorateCodeAction(client: LspClient, action: unknown): unknown {
  if (!isRecord(action)) return action;
  return { ...action, [LSP_RESULT_SERVER_ID_KEY]: client.id };
}

function diagnosticOverlapsLspRange(diagnostic: LspDiagnostic, range: { start: LspPosition; end: LspPosition }): boolean {
  const diagnosticRange = externalRangeToLsp(diagnostic.range);
  return diagnosticRange.start.line <= range.end.line && diagnosticRange.end.line >= range.start.line;
}

function externalRangeToLsp(range: LspDiagnostic["range"]): { start: LspPosition; end: LspPosition } {
  return {
    start: externalPointToLsp(range.start),
    end: externalPointToLsp(range.end),
  };
}

function externalPointToLsp(position: LspDiagnostic["range"]["start"]): LspPosition {
  return {
    line: Math.max(0, Math.floor(position.line) - 1),
    character: Math.max(0, Math.floor(position.character) - 1),
  };
}

function severityToLspNumber(severity: LspDiagnostic["severity"]): number {
  switch (severity) {
    case "error":
      return 1;
    case "warning":
      return 2;
    case "information":
      return 3;
    case "hint":
      return 4;
  }
}

function dedupeResults(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values) {
    const key = stableResultKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function stableResultKey(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function hasHoverContent(value: unknown): boolean {
  return isRecord(value) && markupHasText(value.contents);
}

function markupHasText(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(markupHasText);
  if (!isRecord(value)) return false;
  if (typeof value.value === "string") return value.value.trim().length > 0;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clientKey(root: string, definition: LanguageServerDefinition): string {
  return `${path.resolve(root)}\0${definition.id}\0${definition.command}\0${definition.args.join("\0")}`;
}

export function createLspService(options: LspServiceOptions): LspService {
  return new LspService(options);
}

