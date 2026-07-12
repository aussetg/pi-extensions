import { createHash } from "node:crypto";
import * as path from "node:path";
import { createDiagnosticSnapshot, flattenDiagnosticSnapshot } from "../diagnostics/snapshots.ts";
import { DEFAULT_LSP_SOURCE_FILE_MAX_BYTES, formatBytes, readUtf8IfSmall } from "../fs.ts";
import { resolveWorkspaceRootForPath } from "../language-environments.ts";
import { LSP_RESULT_CODE_ACTION_CAN_RESOLVE_KEY, LSP_RESULT_SERVER_ID_KEY, LSP_RESULT_SERVER_SESSION_ID_KEY, type DiagnosticRefreshResult, type DiagnosticSnapshot, type LspDiagnostic, type LspServiceStatus, type LspUnavailableServer } from "../types.ts";
import { abortError, isCancellation, throwIfAborted } from "./cancellation.ts";
import { LspClient, type DiagnosticSnapshotScope } from "./client.ts";
import { normalizeDiagnosticRefreshConcurrency } from "./diagnostic-refresh.ts";
import { externalPositionToLsp, filePathToUri, oneLineLspRange, type LspPosition } from "./positions.ts";
import { resolveLanguageServer, resolveLanguageServers, type LanguageServerDefinition } from "./servers.ts";
import { canResolveCodeActionOnApply } from "./workspace-edit.ts";

export interface LspServiceOptions {
  projectRoot: string;
  serverOverrides?: Record<string, unknown>;
  trustedEnvironmentRoots?: string[];
  idleTimeoutMs: number;
  diagnosticRefreshConcurrency?: number;
}

export interface DiagnosticsForFileOptions {
  timeoutMs: number;
  settleMs: number;
  snapshotScope?: DiagnosticSnapshotScope;
  signal?: AbortSignal;
}

const CODE_ACTION_DIAGNOSTIC_TIMEOUT_MS = 1200;

interface ClientRequestResult {
  client: LspClient;
  result?: unknown;
  error?: string;
}

interface DiagnosticRefreshJob {
  key: string;
  filePath: string;
  content: string;
  clients: LspClient[];
  options: DiagnosticsForFileOptions;
  waiters: Set<DiagnosticRefreshWaiter>;
  controller: AbortController;
}

interface DiagnosticRefreshWaiter {
  requestedAt: number;
  options: DiagnosticsForFileOptions;
  resolve: (result: DiagnosticRefreshResult | undefined) => void;
  reject: (error: Error) => void;
  settled: boolean;
  timeout?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class LspService {
  private projectRoot: string;
  private serverOverrides: Record<string, unknown>;
  private trustedEnvironmentRoots: string[];
  private idleTimeoutMs: number;
  private diagnosticRefreshConcurrency: number;
  private clients = new Map<string, LspClient>();
  private unavailableServers = new Map<string, LspUnavailableServer>();
  private idleTimer?: NodeJS.Timeout;
  private diagnosticQueue: DiagnosticRefreshJob[] = [];
  private queuedDiagnosticRefreshes = new Map<string, DiagnosticRefreshJob>();
  private runningDiagnosticRefreshes = new Map<string, DiagnosticRefreshJob>();
  private runningDiagnosticRefreshFiles = new Set<string>();
  private diagnosticPumpScheduled = false;

  constructor(options: LspServiceOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.serverOverrides = options.serverOverrides ?? {};
    this.trustedEnvironmentRoots = options.trustedEnvironmentRoots?.map((root) => path.resolve(root)) ?? [];
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.diagnosticRefreshConcurrency = normalizeDiagnosticRefreshConcurrency(options.diagnosticRefreshConcurrency);
  }

  configure(options: LspServiceOptions): void {
    this.projectRoot = path.resolve(options.projectRoot);
    this.serverOverrides = options.serverOverrides ?? {};
    this.trustedEnvironmentRoots = options.trustedEnvironmentRoots?.map((root) => path.resolve(root)) ?? [];
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.diagnosticRefreshConcurrency = normalizeDiagnosticRefreshConcurrency(options.diagnosticRefreshConcurrency, this.diagnosticRefreshConcurrency);
    this.armIdleTimer();
    this.scheduleDiagnosticPump();
  }

  async diagnosticsForFile(filePath: string, content: string | undefined, options: DiagnosticsForFileOptions): Promise<DiagnosticSnapshot | undefined> {
    return (await this.diagnosticsForFileDetailed(filePath, content, options))?.snapshot;
  }

  async diagnosticsForFileDetailed(filePath: string, content: string | undefined, options: DiagnosticsForFileOptions): Promise<DiagnosticRefreshResult | undefined> {
    throwIfAborted(options.signal);
    const resolved = path.resolve(this.projectRoot, filePath);
    const clients = this.getOrCreateClients(resolved);
    if (clients.length === 0) return undefined;

    const finalContent = content ?? readLspSourceFileIfExists(resolved);
    if (finalContent === undefined) {
      const now = Date.now();
      return {
        snapshot: diagnosticSnapshotForClients(clients, filePathToUri(resolved), options.snapshotScope),
        fresh: true,
        timedOut: false,
        requestedAt: now,
        completedAt: now,
      };
    }

    return this.enqueueDiagnosticRefresh(resolved, finalContent, clients, options);
  }

  cachedDiagnostics(pathOrAll?: string): DiagnosticSnapshot {
    if (!pathOrAll || pathOrAll === "all") return this.snapshotAll();

    const resolved = path.resolve(this.projectRoot, pathOrAll);
    const uri = filePathToUri(resolved);
    return this.cachedDiagnosticsForUri(uri);
  }

  cachedDiagnosticsIfKnown(filePath: string): DiagnosticSnapshot | undefined {
    const resolved = path.resolve(this.projectRoot, filePath);
    const uri = filePathToUri(resolved);
    const clients = this.cachedClientsForFile(resolved);
    if (!clients) return undefined;

    const diagnostics = clients.flatMap((client) => client.diagnosticsForUri(uri));
    return createDiagnosticSnapshot(diagnostics);
  }

  private cachedDiagnosticsForUri(uri: string): DiagnosticSnapshot {
    const diagnostics = [...this.clients.values()].flatMap((client) => client.diagnosticsForUri(uri));
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
    const diagnostics = [...this.clients.values()].flatMap((client) => flattenDiagnosticSnapshot(client.snapshot()));
    return createDiagnosticSnapshot(diagnostics);
  }

  async capabilities(filePath?: string, signal?: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    if (!filePath) {
      return this.getStatus();
    }
    const clients = this.getOrCreateClients(path.resolve(this.projectRoot, filePath));
    if (clients.length === 0) return undefined;

    const servers = await Promise.all(clients.map(async (client) => {
      try {
        await client.start(signal);
        return { serverId: client.id, capabilities: client.getCapabilities() };
      } catch (error) {
        if (isCancellation(error, signal)) throw error;
        return { serverId: client.id, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    return servers.length === 1 && !servers[0].error ? servers[0].capabilities : { servers };
  }

  async hover(filePath: string, line: unknown, character: unknown, signal?: AbortSignal): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("hover requires 1-based line and column");
    const results = await this.documentRequests(filePath, "textDocument/hover", { position }, signal);
    return results.map((result) => result.result).find(hasHoverContent);
  }

  async definition(filePath: string, line: unknown, character: unknown, signal?: AbortSignal): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("definition requires 1-based line and column");
    return mergeArrayLikeResults(await this.documentRequests(filePath, "textDocument/definition", { position }, signal));
  }

  async references(filePath: string, line: unknown, character: unknown, signal?: AbortSignal): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("references requires 1-based line and column");
    return mergeArrayLikeResults(await this.documentRequests(filePath, "textDocument/references", { position, context: { includeDeclaration: true } }, signal));
  }

  async implementation(filePath: string, line: unknown, character: unknown, signal?: AbortSignal): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("implementation requires 1-based line and column");
    return mergeArrayLikeResults(await this.documentRequests(filePath, "textDocument/implementation", { position }, signal));
  }

  async typeDefinition(filePath: string, line: unknown, character: unknown, signal?: AbortSignal): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("type_definition requires 1-based line and column");
    return mergeArrayLikeResults(await this.documentRequests(filePath, "textDocument/typeDefinition", { position }, signal));
  }

  async documentSymbols(filePath: string, signal?: AbortSignal): Promise<unknown> {
    return mergeArrayResults(await this.documentRequests(filePath, "textDocument/documentSymbol", {}, signal));
  }

  async workspaceSymbols(query: unknown, filePath?: string, signal?: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    if (typeof query !== "string") throw new Error("workspace_symbols requires query");
    const clients = filePath ? this.getOrCreateClients(path.resolve(this.projectRoot, filePath)) : this.readyOrAnyClients();
    if (clients.length === 0) throw new Error("No active LSP client. Open a file with lsp diagnostics first, or pass path to choose a language server.");
    return mergeArrayResults(await this.clientRequests(clients, "workspace/symbol", { query }, signal));
  }

  async codeActions(filePath: string, line: unknown, character: unknown, signal?: AbortSignal): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("code_actions requires 1-based line and column");
    const range = oneLineLspRange(position);
    const resolved = path.resolve(this.projectRoot, filePath);
    const content = readLspSourceFile(resolved);

    await this.diagnosticsForFileDetailed(resolved, content, {
      timeoutMs: CODE_ACTION_DIAGNOSTIC_TIMEOUT_MS,
      settleMs: 0,
      snapshotScope: "file",
      signal,
    }).catch((error) => {
      if (isCancellation(error, signal)) throw error;
      return undefined;
    });

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
      }, 10_000, signal);
    }, signal);
    return this.mergeCodeActions(results);
  }

  async resolveCodeAction(filePath: string, action: unknown, signal?: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    if (!isRecord(action) || action.edit !== undefined) return action;
    if (!canResolveCodeActionOnApply(action)) {
      throw new Error(`Code action is not resolvable by its source language server: ${path.resolve(this.projectRoot, filePath)}`);
    }

    const resolved = path.resolve(this.projectRoot, filePath);
    const client = this.clientForCodeAction(resolved, action);
    if (!client) {
      const serverId = codeActionServerId(action);
      const sessionId = codeActionServerSessionId(action);
      throw new Error(serverId
        ? sessionId
          ? `Code action source server session is no longer live (${serverId} ${sessionId}): ${resolved}`
          : `Cannot resolve code action without source server session id (${serverId}): ${resolved}`
        : `Cannot resolve code action without source server id: ${resolved}`);
    }

    this.armIdleTimer();
    const resolvedAction = await client.request("codeAction/resolve", stripCodeActionMetadata(action), 10_000, signal);
    this.armIdleTimer();
    return decorateCodeAction(client, mergeCodeActionResolution(action, resolvedAction));
  }

  async rename(filePath: string, line: unknown, character: unknown, newName: unknown, signal?: AbortSignal): Promise<unknown> {
    const position = externalPositionToLsp(line, character);
    if (!position) throw new Error("rename requires 1-based line and column");
    if (typeof newName !== "string" || newName.length === 0) throw new Error("rename requires newName");
    const { result, client } = await this.documentRequest(filePath, "textDocument/rename", { position, newName }, signal);
    return decorateWorkspaceEdit(client, result);
  }

  documentVersion(filePath: string, serverId: string | undefined, serverSessionId: string | undefined): number | undefined {
    if (!serverId || !serverSessionId) return undefined;
    const resolved = path.resolve(this.projectRoot, filePath);
    for (const client of this.clients.values()) {
      if (client.id !== serverId || client.getSessionId() !== serverSessionId) continue;
      const version = client.documentVersion(resolved);
      if (version !== undefined) return version;
    }
    return undefined;
  }

  getStatus(): LspServiceStatus {
    const clients = [...this.clients.values()].map((client) => client.getStatus());
    return {
      activeClients: clients.filter((client) => client.state === "ready" || client.state === "starting").length,
      clients,
      unavailableServers: [...this.unavailableServers.values()],
      diagnosticRefreshes: {
        concurrency: this.diagnosticRefreshConcurrency,
        active: this.runningDiagnosticRefreshes.size,
        running: this.runningDiagnosticRefreshes.size,
        queued: this.queuedDiagnosticRefreshes.size,
      },
    };
  }

  async restart(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.unavailableServers.clear();
    this.finishDiagnosticRefreshWaiters(undefined);
    await Promise.allSettled(clients.map((client) => client.shutdown(signal)));
    throwIfAborted(signal);
    this.armIdleTimer();
  }

  async shutdownAll(signal?: AbortSignal): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.unavailableServers.clear();
    this.finishDiagnosticRefreshWaiters(undefined);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    await Promise.allSettled(clients.map((client) => client.shutdown(signal)));
  }

  private async documentRequest(filePath: string, method: string, extraParams: Record<string, unknown>, signal?: AbortSignal): Promise<{ result: unknown; client: LspClient }> {
    throwIfAborted(signal);
    const resolved = path.resolve(this.projectRoot, filePath);
    const content = readLspSourceFile(resolved);

    const client = this.getOrCreateClient(resolved);
    if (!client) throw new Error(`No language server configured for ${resolved}`);

    const uri = filePathToUri(resolved);
    const params = {
      textDocument: { uri },
      ...extraParams,
    };
    const result = await client.requestForDocument(resolved, content, method, params, 10_000, signal);
    this.armIdleTimer();
    return { result, client };
  }

  private enqueueDiagnosticRefresh(
    filePath: string,
    content: string,
    clients: LspClient[],
    options: DiagnosticsForFileOptions,
  ): Promise<DiagnosticRefreshResult | undefined> {
    throwIfAborted(options.signal);
    const key = diagnosticRefreshKey(filePath, content);

    return new Promise((resolve, reject) => {
      const waiter: DiagnosticRefreshWaiter = {
        requestedAt: Date.now(),
        options,
        resolve,
        reject,
        settled: false,
        signal: options.signal,
      };

      const queued = this.queuedDiagnosticRefreshes.get(key);
      if (queued && queued.content === content) {
        queued.options = mergeDiagnosticRefreshOptions(queued.options, options);
        queued.waiters.add(waiter);
        this.armDiagnosticWaiterTimeout(queued, waiter);
        this.armDiagnosticWaiterAbort(queued, waiter);
        return;
      }

      const running = this.runningDiagnosticRefreshes.get(key);
      if (running && running.content === content && canShareRunningDiagnosticJob(running, options)) {
        running.waiters.add(waiter);
        this.armDiagnosticWaiterTimeout(running, waiter);
        this.armDiagnosticWaiterAbort(running, waiter);
        return;
      }

      const job: DiagnosticRefreshJob = {
        key,
        filePath,
        content,
        clients,
        options: diagnosticJobOptions(options),
        waiters: new Set([waiter]),
        controller: new AbortController(),
      };
      this.queuedDiagnosticRefreshes.set(key, job);
      this.diagnosticQueue.push(job);
      this.armDiagnosticWaiterTimeout(job, waiter);
      this.armDiagnosticWaiterAbort(job, waiter);
      this.scheduleDiagnosticPump();
    });
  }

  private scheduleDiagnosticPump(): void {
    if (this.diagnosticPumpScheduled) return;
    this.diagnosticPumpScheduled = true;
    queueMicrotask(() => {
      this.diagnosticPumpScheduled = false;
      this.pumpDiagnosticQueue();
    });
  }

  private pumpDiagnosticQueue(): void {
    while (this.runningDiagnosticRefreshes.size < this.diagnosticRefreshConcurrency) {
      const job = this.takeNextDiagnosticRefreshJob();
      if (!job) break;

      this.runningDiagnosticRefreshes.set(job.key, job);
      this.runningDiagnosticRefreshFiles.add(job.filePath);
      void this.runDiagnosticRefreshJob(job).finally(() => {
        if (this.runningDiagnosticRefreshes.get(job.key) === job) {
          this.runningDiagnosticRefreshes.delete(job.key);
          this.runningDiagnosticRefreshFiles.delete(job.filePath);
        }
        this.pumpDiagnosticQueue();
      });
    }
  }

  private takeNextDiagnosticRefreshJob(): DiagnosticRefreshJob | undefined {
    for (let index = 0; index < this.diagnosticQueue.length; index += 1) {
      const job = this.diagnosticQueue[index];
      if (!job) continue;

      if (this.queuedDiagnosticRefreshes.get(job.key) !== job || job.waiters.size === 0) {
        this.diagnosticQueue.splice(index, 1);
        if (this.queuedDiagnosticRefreshes.get(job.key) === job) this.queuedDiagnosticRefreshes.delete(job.key);
        index -= 1;
        continue;
      }

      // Keep versions for a single URI ordered even when the global queue runs
      // multiple files at once. Concurrent refreshes for the same file can make
      // older LSP publishDiagnostics responses look fresh for newer content.
      if (this.runningDiagnosticRefreshFiles.has(job.filePath)) continue;

      this.diagnosticQueue.splice(index, 1);
      this.queuedDiagnosticRefreshes.delete(job.key);
      return job;
    }

    return undefined;
  }

  private async runDiagnosticRefreshJob(job: DiagnosticRefreshJob): Promise<void> {
    let result: DiagnosticRefreshResult | undefined;
    try {
      result = await this.performDiagnosticRefresh(job.filePath, job.content, job.clients, {
        ...job.options,
        signal: job.controller.signal,
      });
    } catch {
      result = undefined;
    }

    for (const waiter of [...job.waiters]) {
      this.resolveDiagnosticWaiter(job, waiter, result ? diagnosticResultForWaiter(result, job, waiter) : undefined);
    }
  }

  private async performDiagnosticRefresh(
    filePath: string,
    content: string,
    clients: LspClient[],
    options: DiagnosticsForFileOptions,
  ): Promise<DiagnosticRefreshResult | undefined> {
    const results = await Promise.all(clients.map(async (client) => {
      try {
        return await client.touchDocumentDetailed(filePath, content, options);
      } catch (error) {
        if (isCancellation(error, options.signal)) return undefined;
        this.markClientInstanceError(filePath, client, error);
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

  private armDiagnosticWaiterTimeout(job: DiagnosticRefreshJob, waiter: DiagnosticRefreshWaiter): void {
    waiter.timeout = setTimeout(() => {
      this.resolveDiagnosticWaiter(job, waiter, timedOutDiagnosticRefresh(job, waiter));
    }, Math.max(0, waiter.options.timeoutMs));
    waiter.timeout.unref?.();
  }

  private armDiagnosticWaiterAbort(job: DiagnosticRefreshJob, waiter: DiagnosticRefreshWaiter): void {
    if (!waiter.signal) return;
    waiter.onAbort = () => this.rejectDiagnosticWaiter(job, waiter, abortError(waiter.signal));
    waiter.signal.addEventListener("abort", waiter.onAbort, { once: true });
    if (waiter.signal.aborted) waiter.onAbort();
  }

  private resolveDiagnosticWaiter(
    job: DiagnosticRefreshJob,
    waiter: DiagnosticRefreshWaiter,
    result: DiagnosticRefreshResult | undefined,
  ): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timeout) clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    job.waiters.delete(waiter);
    waiter.resolve(result);
  }

  private rejectDiagnosticWaiter(job: DiagnosticRefreshJob, waiter: DiagnosticRefreshWaiter, error: Error): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timeout) clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    job.waiters.delete(waiter);
    waiter.reject(error);
    if (job.waiters.size === 0) {
      job.controller.abort();
      this.scheduleDiagnosticPump();
    }
  }

  private finishDiagnosticRefreshWaiters(result: DiagnosticRefreshResult | undefined): void {
    const jobs = new Set<DiagnosticRefreshJob>([
      ...this.diagnosticQueue,
      ...this.queuedDiagnosticRefreshes.values(),
      ...this.runningDiagnosticRefreshes.values(),
    ]);

    this.diagnosticQueue = [];
    this.queuedDiagnosticRefreshes.clear();
    this.runningDiagnosticRefreshes.clear();
    this.runningDiagnosticRefreshFiles.clear();

    for (const job of jobs) {
      job.controller.abort();
      for (const waiter of [...job.waiters]) {
        this.resolveDiagnosticWaiter(job, waiter, result);
      }
    }
  }

  private async documentRequests(filePath: string, method: string, extraParams: Record<string, unknown>, signal?: AbortSignal): Promise<ClientRequestResult[]> {
    throwIfAborted(signal);
    const resolved = path.resolve(this.projectRoot, filePath);
    const content = readLspSourceFile(resolved);

    const clients = this.getOrCreateClients(resolved);
    if (clients.length === 0) throw new Error(`No language server configured for ${resolved}`);

    const uri = filePathToUri(resolved);
    const params = {
      textDocument: { uri },
      ...extraParams,
    };
    return this.runClientRequests(clients, method, (client) => client.requestForDocument(resolved, content, method, params, 10_000, signal), signal);
  }

  private async clientRequests(clients: LspClient[], method: string, params: unknown, signal?: AbortSignal): Promise<ClientRequestResult[]> {
    return this.runClientRequests(clients, method, (client) => client.request(method, params, 10_000, signal), signal);
  }

  private async runClientRequests(
    clients: LspClient[],
    method: string,
    run: (client: LspClient) => Promise<unknown>,
    signal?: AbortSignal,
  ): Promise<ClientRequestResult[]> {
    throwIfAborted(signal);
    const results = await Promise.all(clients.map(async (client): Promise<ClientRequestResult> => {
      try {
        return { client, result: await run(client) };
      } catch (error) {
        if (isCancellation(error, signal)) throw error;
        return { client, error: error instanceof Error ? error.message : String(error) };
      }
    }));

    if (!results.some((result) => result.error === undefined)) {
      throw new Error(`All language servers failed ${method}: ${results.map((result) => `${result.client.id}: ${result.error ?? "unknown error"}`).join("; ")}`);
    }

    this.armIdleTimer();
    return results;
  }

  private mergeCodeActions(results: ClientRequestResult[]): unknown[] {
    const actions = results.flatMap((result) => {
      if (!Array.isArray(result.result)) return [];
      return result.result.map((action) => decorateCodeAction(result.client, action));
    });
    this.armIdleTimer();
    return actions;
  }

  private clientForCodeAction(filePath: string, action: Record<string, unknown>): LspClient | undefined {
    const serverId = codeActionServerId(action);
    const sessionId = codeActionServerSessionId(action);
    if (!serverId || !sessionId) return undefined;

    return this.existingClientsForFile(filePath).find((client) => (
      client.id === serverId &&
      client.getSessionId() === sessionId &&
      client.getStatus().state === "ready"
    ));
  }

  private existingClientsForFile(filePath: string): LspClient[] {
    const resolved = path.resolve(this.projectRoot, filePath);
    const root = this.workspaceRootForFile(resolved);
    const clients: LspClient[] = [];

    for (const resolvedServer of resolveLanguageServers(resolved, this.serverOverrides, root, this.trustedEnvironmentRoots)) {
      if (!resolvedServer.available) continue;
      const client = this.clients.get(clientKey(root, resolvedServer.definition));
      if (client) clients.push(client);
    }

    return clients;
  }

  private getOrCreateClient(filePath: string): LspClient | undefined {
    const resolved = path.resolve(filePath);
    const root = this.workspaceRootForFile(resolved);
    const resolvedServer = resolveLanguageServer(resolved, this.serverOverrides, root, this.trustedEnvironmentRoots);
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
    const root = this.workspaceRootForFile(resolved);
    const clients: LspClient[] = [];

    for (const resolvedServer of resolveLanguageServers(resolved, this.serverOverrides, root, this.trustedEnvironmentRoots)) {
      if (!resolvedServer.available) {
        this.unavailableServers.set(resolvedServer.definition.id, {
          id: resolvedServer.definition.id,
          command: resolvedServer.definition.command,
          filePath: resolved,
          reason: resolvedServer.unavailableReason ?? "unavailable",
        });
        continue;
      }

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
    const root = this.workspaceRootForFile(resolved);
    const uri = filePathToUri(resolved);
    const clients: LspClient[] = [];

    for (const resolvedServer of resolveLanguageServers(resolved, this.serverOverrides, root, this.trustedEnvironmentRoots)) {
      if (!resolvedServer.available) continue;
      const key = clientKey(root, resolvedServer.definition);
      const client = this.clients.get(key);
      if (!client || !client.hasDiagnosticsForUri(uri)) return undefined;
      clients.push(client);
    }

    return clients.length > 0 ? clients : undefined;
  }

  private workspaceRootForFile(filePath: string): string {
    return resolveWorkspaceRootForPath(filePath, this.projectRoot, this.trustedEnvironmentRoots);
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
  const diagnostics = snapshots.flatMap(flattenDiagnosticSnapshot);
  return createDiagnosticSnapshot(diagnostics);
}

function diagnosticSnapshotForClients(clients: LspClient[], uri: string, scope: DiagnosticSnapshotScope | undefined): DiagnosticSnapshot {
  if (scope === "workspace") return mergeSnapshots(clients.map((client) => client.snapshot()));
  return createDiagnosticSnapshot(clients.flatMap((client) => client.diagnosticsForUri(uri)));
}

function mergeDiagnosticRefreshOptions(left: DiagnosticsForFileOptions, right: DiagnosticsForFileOptions): DiagnosticsForFileOptions {
  return {
    timeoutMs: Math.max(left.timeoutMs, right.timeoutMs),
    settleMs: Math.max(left.settleMs, right.settleMs),
    snapshotScope: mergeDiagnosticSnapshotScope(left.snapshotScope, right.snapshotScope),
  };
}

function diagnosticJobOptions(options: DiagnosticsForFileOptions): DiagnosticsForFileOptions {
  return {
    timeoutMs: options.timeoutMs,
    settleMs: options.settleMs,
    snapshotScope: options.snapshotScope,
  };
}

function mergeDiagnosticSnapshotScope(left: DiagnosticSnapshotScope | undefined, right: DiagnosticSnapshotScope | undefined): DiagnosticSnapshotScope | undefined {
  return left === "workspace" || right === "workspace" ? "workspace" : undefined;
}

function canShareRunningDiagnosticJob(job: DiagnosticRefreshJob, options: DiagnosticsForFileOptions): boolean {
  if (options.snapshotScope === "workspace" && job.options.snapshotScope !== "workspace") return false;
  return options.timeoutMs <= job.options.timeoutMs && options.settleMs <= job.options.settleMs;
}

function timedOutDiagnosticRefresh(job: DiagnosticRefreshJob, waiter: DiagnosticRefreshWaiter): DiagnosticRefreshResult {
  const now = Date.now();
  return {
    snapshot: diagnosticSnapshotForClients(job.clients, filePathToUri(job.filePath), waiter.options.snapshotScope),
    fresh: false,
    timedOut: true,
    requestedAt: waiter.requestedAt,
    completedAt: now,
  };
}

function diagnosticResultForWaiter(result: DiagnosticRefreshResult, job: DiagnosticRefreshJob, waiter: DiagnosticRefreshWaiter): DiagnosticRefreshResult {
  const uri = filePathToUri(job.filePath);
  return {
    ...result,
    snapshot: waiter.options.snapshotScope === "workspace" ? result.snapshot : snapshotForUri(result.snapshot, uri),
    requestedAt: waiter.requestedAt,
  };
}

function snapshotForUri(snapshot: DiagnosticSnapshot, uri: string): DiagnosticSnapshot {
  return createDiagnosticSnapshot(snapshot.byUri.get(uri) ?? [], snapshot.takenAt);
}

function diagnosticRefreshKey(filePath: string, content: string): string {
  return `${path.resolve(filePath)}\0${content.length}\0${hashString(content)}`;
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
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
  const sessionId = client.getSessionId();
  const canResolve = action.edit === undefined && !isTopLevelCommandResult(action) && sessionId && client.canResolveCodeActions();
  return {
    ...action,
    [LSP_RESULT_SERVER_ID_KEY]: client.id,
    ...(sessionId ? { [LSP_RESULT_SERVER_SESSION_ID_KEY]: sessionId } : {}),
    ...(canResolve ? { [LSP_RESULT_CODE_ACTION_CAN_RESOLVE_KEY]: true } : {}),
  };
}

function decorateWorkspaceEdit(client: LspClient, edit: unknown): unknown {
  if (!isRecord(edit)) return edit;
  const sessionId = client.getSessionId();
  return {
    ...edit,
    [LSP_RESULT_SERVER_ID_KEY]: client.id,
    ...(sessionId ? { [LSP_RESULT_SERVER_SESSION_ID_KEY]: sessionId } : {}),
  };
}

function isTopLevelCommandResult(action: Record<string, unknown>): boolean {
  return typeof action.command === "string";
}

function codeActionServerId(action: Record<string, unknown>): string | undefined {
  return typeof action[LSP_RESULT_SERVER_ID_KEY] === "string" ? action[LSP_RESULT_SERVER_ID_KEY] : undefined;
}

function codeActionServerSessionId(action: Record<string, unknown>): string | undefined {
  return typeof action[LSP_RESULT_SERVER_SESSION_ID_KEY] === "string" ? action[LSP_RESULT_SERVER_SESSION_ID_KEY] : undefined;
}

function stripCodeActionMetadata(action: Record<string, unknown>): Record<string, unknown> {
  const {
    [LSP_RESULT_SERVER_ID_KEY]: _serverId,
    [LSP_RESULT_SERVER_SESSION_ID_KEY]: _sessionId,
    [LSP_RESULT_CODE_ACTION_CAN_RESOLVE_KEY]: _canResolve,
    ...rest
  } = action;
  return rest;
}

function mergeCodeActionResolution(original: Record<string, unknown>, resolved: unknown): Record<string, unknown> {
  const cleanOriginal = stripCodeActionMetadata(original);
  if (!isRecord(resolved)) return cleanOriginal;
  return { ...cleanOriginal, ...stripCodeActionMetadata(resolved) };
}

function diagnosticOverlapsLspRange(diagnostic: LspDiagnostic, range: { start: LspPosition; end: LspPosition }): boolean {
  const diagnosticRange = externalRangeToLsp(diagnostic.range);
  if (!diagnosticRange) return false;
  return diagnosticRange.start.line <= range.end.line && diagnosticRange.end.line >= range.start.line;
}

function externalRangeToLsp(range: LspDiagnostic["range"]): { start: LspPosition; end: LspPosition } | undefined {
  const start = externalPositionToLsp(range.start.line, range.start.character);
  const end = externalPositionToLsp(range.end.line, range.end.character);
  return start && end ? { start, end } : undefined;
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
  const hash = createHash("sha256");
  hashStableValue(hash, value, new WeakSet<object>(), 0);
  return `result:${hash.digest("hex").slice(0, 24)}`;
}

function hashStableValue(
  hash: ReturnType<typeof createHash>,
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): void {
  if (depth > 64) {
    hash.update("depth\0");
    return;
  }
  if (value === null) {
    hash.update("null\0");
    return;
  }

  switch (typeof value) {
    case "string":
      hash.update("string\0");
      hashStringPart(hash, value);
      return;
    case "number":
      hash.update(`number\0${Object.is(value, -0) ? "-0" : String(value)}\0`);
      return;
    case "boolean":
    case "bigint":
    case "undefined":
      hash.update(`${typeof value}\0${String(value)}\0`);
      return;
    case "symbol":
    case "function":
      hash.update(`${typeof value}\0`);
      return;
    case "object": {
      if (seen.has(value)) {
        hash.update("cycle\0");
        return;
      }
      seen.add(value);
      if (Array.isArray(value)) {
        hash.update(`array\0${value.length}\0`);
        for (const item of value) hashStableValue(hash, item, seen, depth + 1);
      } else {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        hash.update(`object\0${keys.length}\0`);
        for (const key of keys) {
          hashStringPart(hash, key);
          hashStableValue(hash, record[key], seen, depth + 1);
        }
      }
      seen.delete(value);
    }
  }
}

function hashStringPart(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(String(value.length));
  hash.update("\0");
  hash.update(value);
  hash.update("\0");
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

function readLspSourceFile(filePath: string): string {
  const content = readLspSourceFileIfExists(filePath);
  if (content === undefined) throw new Error(`Cannot read file for LSP request: ${filePath}`);
  return content;
}

function readLspSourceFileIfExists(filePath: string): string | undefined {
  const result = readUtf8IfSmall(filePath, DEFAULT_LSP_SOURCE_FILE_MAX_BYTES);
  if (result.skippedReason === "too-large") {
    const size = result.size === undefined ? "unknown size" : formatBytes(result.size);
    throw new Error(`LSP source file is too large (${size} > ${formatBytes(DEFAULT_LSP_SOURCE_FILE_MAX_BYTES)} limit): ${filePath}`);
  }
  return result.content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clientKey(root: string, definition: LanguageServerDefinition): string {
  return `${path.resolve(root)}\0${definition.id}\0${definition.command}\0${definition.args.join("\0")}\0${definition.environment?.key ?? ""}`;
}

export function createLspService(options: LspServiceOptions): LspService {
  return new LspService(options);
}

