import * as path from "node:path";
import { createDiagnosticSnapshot } from "../diagnostics/snapshots.ts";
import { readUtf8IfExists } from "../fs.ts";
import type { DiagnosticRefreshResult, DiagnosticSnapshot, LspServiceStatus, LspUnavailableServer } from "../types.ts";
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
    const client = this.getOrCreateClient(path.resolve(this.projectRoot, filePath));
    if (!client) return undefined;
    try {
      await client.start();
    } catch {
      // Status rendering will include the client error if startup failed.
    }
    return client.getCapabilities();
  }

  async hover(filePath: string, line: unknown, character: unknown): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("hover requires 1-based line and character");
    return this.documentRequest(filePath, "textDocument/hover", { position });
  }

  async definition(filePath: string, line: unknown, character: unknown): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("definition requires 1-based line and character");
    return this.documentRequest(filePath, "textDocument/definition", { position });
  }

  async references(filePath: string, line: unknown, character: unknown): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("references requires 1-based line and character");
    return this.documentRequest(filePath, "textDocument/references", { position, context: { includeDeclaration: true } });
  }

  async implementation(filePath: string, line: unknown, character: unknown): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("implementation requires 1-based line and character");
    return this.documentRequest(filePath, "textDocument/implementation", { position });
  }

  async typeDefinition(filePath: string, line: unknown, character: unknown): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("type_definition requires 1-based line and character");
    return this.documentRequest(filePath, "textDocument/typeDefinition", { position });
  }

  async documentSymbols(filePath: string): Promise<unknown> {
    return this.documentRequest(filePath, "textDocument/documentSymbol", {});
  }

  async workspaceSymbols(query: unknown, filePath?: string): Promise<unknown> {
    if (typeof query !== "string") throw new Error("workspace_symbols requires query");
    const client = filePath ? this.getOrCreateClient(path.resolve(this.projectRoot, filePath)) : this.firstReadyOrAnyClient();
    if (!client) throw new Error("No active LSP client. Open a file with lsp diagnostics first, or pass path to choose a language server.");
    return client.request("workspace/symbol", { query });
  }

  async codeActions(filePath: string, line: unknown, character: unknown): Promise<unknown> {
    const position = externalPositionToLsp(line, character) ?? { line: 0, character: 0 };
    const range = oneLineLspRange(position);
    return this.documentRequest(filePath, "textDocument/codeAction", {
      range,
      context: { diagnostics: [] },
    });
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

  private firstReadyOrAnyClient(): LspClient | undefined {
    return [...this.clients.values()].find((client) => client.getStatus().state === "ready") ?? this.clients.values().next().value;
  }

  private markClientError(filePath: string, error: unknown): void {
    const resolvedServer = resolveLanguageServer(filePath, this.serverOverrides, this.projectRoot);
    if (!resolvedServer) return;
    this.unavailableServers.set(resolvedServer.definition.id, {
      id: resolvedServer.definition.id,
      command: resolvedServer.definition.command,
      filePath,
      reason: error instanceof Error ? error.message : String(error),
    });
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

function clientKey(root: string, definition: LanguageServerDefinition): string {
  return `${path.resolve(root)}\0${definition.id}\0${definition.command}\0${definition.args.join("\0")}`;
}

export function createLspService(options: LspServiceOptions): LspService {
  return new LspService(options);
}

