import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { countDiagnosticSnapshotDiagnostics, createDiagnosticSnapshot, flattenDiagnosticSnapshot } from "../diagnostics/snapshots.ts";
import { errorMessage, isErrorCode } from "../errors.ts";
import { DEFAULT_LSP_SOURCE_FILE_MAX_BYTES, formatBytes, readDescriptorUpTo, readUtf8IfSmall, realpathIfExists } from "../fs.ts";
import { resolveWorkspaceRootForPath } from "../language-environments.ts";
import { isInsideOrEqual } from "../paths.ts";
import { contentHash } from "../runtime.ts";
import { isRecord, LSP_RESULT_CODE_ACTION_CAN_RESOLVE_KEY, LSP_RESULT_SERVER_ID_KEY, LSP_RESULT_SERVER_SESSION_ID_KEY, type DiagnosticRefreshResult, type DiagnosticSnapshot, type LspDiagnostic, type LspServiceStatus, type LspUnavailableServer, type WorkspaceDiagnosticFileResult, type WorkspaceDiagnosticScanResult } from "../types.ts";
import { abortError, isCancellation, throwIfAborted } from "./cancellation.ts";
import { LspClient, type DiagnosticSnapshotScope, type OpenDocumentState } from "./client.ts";
import { normalizeDiagnosticRefreshConcurrency, normalizeLspInitializationConcurrency, normalizeMaxActiveLspClients } from "./client-resources.ts";
import {
  lspFileMutationPaths,
  MAX_RECONCILED_OPEN_DOCUMENT_BYTES,
  MAX_RECONCILED_OPEN_DOCUMENT_TOTAL_BYTES,
  MAX_RECONCILED_OPEN_DOCUMENTS,
  type LspFileMutation,
  type OpenDocumentReconciliationOptions,
  type OpenDocumentReconciliationResult,
} from "./file-mutations.ts";
import { externalPositionToLsp, filePathToUri, oneLineLspRange, resolveExternalPositionTarget, type ExternalPositionTarget, type LspPosition } from "./positions.ts";
import type { LanguageServerConfiguration } from "./server-config.ts";
import { configuredLanguageServerIds, languageServerExtensions, languageServerRootMarkers, resolveLanguageServers, type LanguageServerDefinition, type LanguageServerRootCache, type ResolvedLanguageServer } from "./servers.ts";
import {
  discoverWorkspaceDiagnosticFiles,
  MAX_WORKSPACE_DIAGNOSTIC_ENTRIES,
  normalizeWorkspaceDiagnosticFileLimit,
  readWorkspaceDiagnosticSource,
  type WorkspaceDiagnosticDiscovery,
  type WorkspaceDiagnosticSourceReadResult,
} from "./workspace-diagnostics.ts";
import { canResolveCodeActionOnApply, resolveFileRenameOperation } from "./workspace-edit.ts";

export interface LspServiceConfiguration {
  projectRoot: string;
  trustedEnvironmentRoots?: string[];
  idleTimeoutMs: number;
  maxActiveClients?: number;
  initializationConcurrency?: number;
  diagnosticRefreshConcurrency?: number;
  serverConfiguration?: LanguageServerConfiguration;
}

export interface LspServiceOptions extends LspServiceConfiguration {
  serverOverrides?: Record<string, unknown>;
}

export interface DiagnosticsForFileOptions {
  timeoutMs: number;
  settleMs: number;
  snapshotScope?: DiagnosticSnapshotScope;
  forceFresh?: boolean;
  server?: string;
  signal?: AbortSignal;
}

export interface WorkspaceDiagnosticsOptions {
  limit: number;
  timeoutMs: number;
  settleMs: number;
  server?: string;
  signal?: AbortSignal;
}

export const EXPLICIT_LSP_DIAGNOSTIC_TIMEOUT_MS = 10_000;

interface ClientRequestResult {
  client: LspClient;
  result?: unknown;
  error?: string;
}

interface PositionedDocument {
  filePath: string;
  content: string;
  position: LspPosition;
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

interface ClientStartWaiter {
  client: LspClient;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

interface WorkspaceDiagnosticFilePlan {
  index: number;
  filePath: string;
  uri: string;
  content: string;
  contentHash: string;
  clients: LspClient[];
}

interface WorkspaceDiagnosticClientFileResult {
  outcome: "fresh" | "timed-out" | "unavailable";
  snapshot?: DiagnosticSnapshot;
  reason?: string;
  contentHash?: string;
  protocol?: "workspace-pull" | "document-refresh";
}

interface WorkspaceDiagnosticFallbackPlan {
  plan: WorkspaceDiagnosticFilePlan;
  content: string;
  contentHash: string;
}

interface WorkspaceDiagnosticExecutionStats {
  workspacePullRequests: number;
  workspacePullFailures: number;
  workspacePullFiles: Set<string>;
  documentRefreshFiles: Set<string>;
}

interface AsyncPermitWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

class AsyncPermitPool {
  private active = 0;
  private readonly waiters: AsyncPermitWaiter[] = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releasePermit());
    }

    return new Promise((resolve, reject) => {
      const waiter: AsyncPermitWaiter = { resolve, reject, signal, settled: false };
      if (signal) {
        waiter.onAbort = () => {
          if (waiter.settled) return;
          waiter.settled = true;
          signal.removeEventListener("abort", waiter.onAbort!);
          reject(abortError(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      if (signal?.aborted) waiter.onAbort?.();
    });
  }

  private releasePermit(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift()!;
        if (waiter.settled) continue;
        waiter.settled = true;
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.resolve(this.releasePermit());
        return;
      }
      this.active = Math.max(0, this.active - 1);
    };
  }
}

type ClientEvictionReason = "idle" | "capacity";

export class LspService {
  private projectRoot: string;
  private readonly serverOverrides: Record<string, unknown>;
  private serverConfiguration?: LanguageServerConfiguration;
  private trustedEnvironmentRoots: string[];
  private idleTimeoutMs: number;
  private maxActiveClients: number;
  private initializationConcurrency: number;
  private diagnosticRefreshConcurrency: number;
  private clients = new Map<string, LspClient>();
  private unavailableServers = new Map<string, LspUnavailableServer>();
  private rootCache: LanguageServerRootCache = new Map();
  private rootMarkerNames: Set<string>;
  private idleTimer?: NodeJS.Timeout;
  private idleSweepRunning = false;
  private startQueue: ClientStartWaiter[] = [];
  private initializingClients = new Set<LspClient>();
  private evictingClients = new Set<LspClient>();
  private resourcePumpScheduled = false;
  private resourcePumpRunning = false;
  private resourcePumpRequested = false;
  private startsPaused = false;
  private clientStartCount = 0;
  private clientRestartCount = 0;
  private clientEvictionCount = 0;
  private idleEvictionCount = 0;
  private capacityEvictionCount = 0;
  private initializationCooldownCount = 0;
  private diagnosticQueue: DiagnosticRefreshJob[] = [];
  private queuedDiagnosticRefreshes = new Map<string, DiagnosticRefreshJob>();
  private runningDiagnosticRefreshes = new Map<string, DiagnosticRefreshJob>();
  private runningDiagnosticRefreshFiles = new Set<string>();
  private diagnosticPumpScheduled = false;
  private workspaceDiagnosticClients = new Set<LspClient>();
  private openDocumentReconciliationCursor = 0;

  constructor(options: LspServiceOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.serverOverrides = options.serverOverrides ?? {};
    this.serverConfiguration = options.serverConfiguration;
    this.rootMarkerNames = languageServerRootMarkers(options.serverConfiguration?.servers);
    this.trustedEnvironmentRoots = options.trustedEnvironmentRoots?.map((root) => path.resolve(root)) ?? [];
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.maxActiveClients = normalizeMaxActiveLspClients(options.maxActiveClients);
    this.initializationConcurrency = normalizeLspInitializationConcurrency(options.initializationConcurrency);
    this.diagnosticRefreshConcurrency = normalizeDiagnosticRefreshConcurrency(options.diagnosticRefreshConcurrency);
  }

  configure(options: LspServiceConfiguration): void {
    const projectRoot = path.resolve(options.projectRoot);
    const trustedEnvironmentRoots = options.trustedEnvironmentRoots?.map((root) => path.resolve(root)) ?? [];
    const serverConfigurationChanged = options.serverConfiguration !== undefined && options.serverConfiguration !== this.serverConfiguration;
    if (
      projectRoot !== this.projectRoot ||
      serverConfigurationChanged ||
      !samePaths(trustedEnvironmentRoots, this.trustedEnvironmentRoots)
    ) {
      this.rootCache.clear();
      this.openDocumentReconciliationCursor = 0;
    }
    this.projectRoot = projectRoot;
    if (options.serverConfiguration !== undefined) {
      this.serverConfiguration = options.serverConfiguration;
      this.rootMarkerNames = languageServerRootMarkers(options.serverConfiguration.servers);
    }
    this.trustedEnvironmentRoots = trustedEnvironmentRoots;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.maxActiveClients = normalizeMaxActiveLspClients(options.maxActiveClients, this.maxActiveClients);
    this.initializationConcurrency = normalizeLspInitializationConcurrency(options.initializationConcurrency, this.initializationConcurrency);
    this.diagnosticRefreshConcurrency = normalizeDiagnosticRefreshConcurrency(options.diagnosticRefreshConcurrency, this.diagnosticRefreshConcurrency);
    this.armIdleTimer();
    this.scheduleResourcePump();
    this.scheduleDiagnosticPump();
  }

  async diagnosticsForFile(filePath: string, content: string | undefined, options: DiagnosticsForFileOptions): Promise<DiagnosticSnapshot | undefined> {
    return (await this.diagnosticsForFileDetailed(filePath, content, options))?.snapshot;
  }

  async diagnosticsForFileDetailed(filePath: string, content: string | undefined, options: DiagnosticsForFileOptions): Promise<DiagnosticRefreshResult | undefined> {
    throwIfAborted(options.signal);
    const resolved = path.resolve(this.projectRoot, filePath);
    const clients = this.getOrCreateClients(resolved, options.server, options.server !== undefined);
    if (clients.length === 0) return undefined;

    const finalContent = content ?? readLspSourceFileIfExists(resolved);
    if (finalContent === undefined) {
      const now = Date.now();
      return {
        snapshot: options.forceFresh
          ? createDiagnosticSnapshot([])
          : diagnosticSnapshotForClients(clients, filePathToUri(resolved), options.snapshotScope),
        fresh: options.forceFresh !== true,
        timedOut: false,
        requestedAt: now,
        completedAt: now,
      };
    }

    return this.enqueueDiagnosticRefresh(resolved, finalContent, clients, options);
  }

  async diagnosticsForWorkspace(targetPath: string, options: WorkspaceDiagnosticsOptions): Promise<WorkspaceDiagnosticScanResult> {
    throwIfAborted(options.signal);
    const startedAt = Date.now();
    const projectRoot = this.projectRoot;
    const limit = normalizeWorkspaceDiagnosticFileLimit(options.limit);
    if (options.server !== undefined) {
      this.assertKnownServerSelector(options.server);
      if (this.serverConfiguration?.servers[options.server]?.disabled) {
        throw new Error(`Language server ${JSON.stringify(options.server)} is disabled by config.`);
      }
    }

    const discovery = await discoverWorkspaceDiagnosticFiles({
      projectRoot,
      targetPath,
      extensions: languageServerExtensions(this.serverConfiguration?.servers, options.server),
      limit,
      maxEntries: MAX_WORKSPACE_DIAGNOSTIC_ENTRIES,
      signal: options.signal,
    });
    const files = new Array<WorkspaceDiagnosticFileResult>(discovery.files.length);
    const snapshots = new Array<DiagnosticSnapshot | undefined>(discovery.files.length);
    const plans: WorkspaceDiagnosticFilePlan[] = [];
    const plansByClient = new Map<LspClient, WorkspaceDiagnosticFilePlan[]>();

    for (let index = 0; index < discovery.files.length; index += 1) {
      throwIfAborted(options.signal);
      const filePath = discovery.files[index];
      const source = readWorkspaceDiagnosticSource(discovery, filePath, DEFAULT_LSP_SOURCE_FILE_MAX_BYTES);
      if (source.content === undefined) {
        files[index] = {
          filePath,
          outcome: "skipped",
          diagnostics: 0,
          reason: workspaceSourceSkipReason(source),
        };
        continue;
      }

      try {
        const clients = this.getOrCreateClients(filePath, options.server, options.server !== undefined);
        if (clients.length === 0) {
          files[index] = {
            filePath,
            outcome: "unavailable",
            diagnostics: 0,
            reason: "no available language server matched the file",
          };
          continue;
        }

        const plan: WorkspaceDiagnosticFilePlan = {
          index,
          filePath,
          uri: filePathToUri(filePath),
          content: source.content,
          contentHash: contentHash(source.content),
          clients,
        };
        plans.push(plan);
        for (const client of clients) {
          const clientPlans = plansByClient.get(client) ?? [];
          clientPlans.push(plan);
          plansByClient.set(client, clientPlans);
        }
      } catch (error) {
        if (isCancellation(error, options.signal)) throw error;
        files[index] = {
          filePath,
          outcome: "unavailable",
          diagnostics: 0,
          reason: errorMessage(error),
        };
      }
    }

    const clientResults = new Map<LspClient, Map<string, WorkspaceDiagnosticClientFileResult>>();
    const executionStats: WorkspaceDiagnosticExecutionStats = {
      workspacePullRequests: 0,
      workspacePullFailures: 0,
      workspacePullFiles: new Set(),
      documentRefreshFiles: new Set(),
    };
    await this.executeWorkspaceDiagnosticPlans(discovery, plansByClient, clientResults, executionStats, options);
    throwIfAborted(options.signal);
    this.revalidateWorkspaceDiagnosticResults(discovery, plans, clientResults, executionStats, options.signal);

    for (const plan of plans) {
      const results = plan.clients
        .map((client) => clientResults.get(client)?.get(plan.filePath))
        .filter((result): result is WorkspaceDiagnosticClientFileResult => result !== undefined);
      if (results.length === 0) {
        files[plan.index] = {
          filePath: plan.filePath,
          outcome: "unavailable",
          diagnostics: 0,
          reason: workspaceDiagnosticUnavailableReason(results),
        };
        continue;
      }

      const freshResults = results.filter((result) => result.outcome === "fresh" && result.snapshot !== undefined);
      const timedOut = results.some((result) => result.outcome === "timed-out");
      const unavailable = results.length < plan.clients.length ||
        results.some((result) => result.outcome === "unavailable" || (result.outcome === "fresh" && result.snapshot === undefined)) ||
        (!timedOut && freshResults.length === 0);
      const snapshot = mergeSnapshots(freshResults.map((result) => result.snapshot!));
      if (freshResults.length > 0) snapshots[plan.index] = snapshot;
      files[plan.index] = {
        filePath: plan.filePath,
        outcome: timedOut ? "timed-out" : unavailable ? "unavailable" : "fresh",
        diagnostics: countDiagnosticSnapshotDiagnostics(snapshot),
        ...(!timedOut && unavailable ? { reason: workspaceDiagnosticUnavailableReason(results) } : {}),
      };
    }

    const snapshot = mergeSnapshots(snapshots.filter((entry): entry is DiagnosticSnapshot => entry !== undefined));
    const freshFiles = files.filter((file) => file.outcome === "fresh").length;
    const timedOutFiles = files.filter((file) => file.outcome === "timed-out").length;
    const unavailableFiles = files.filter((file) => file.outcome === "unavailable").length;
    const skippedFiles = files.filter((file) => file.outcome === "skipped").length;
    const traversalComplete = !discovery.fileLimitReached && !discovery.entryLimitReached && discovery.walkErrors === 0;
    const complete = traversalComplete && timedOutFiles === 0 && unavailableFiles === 0 && skippedFiles === 0;

    return {
      snapshot,
      files,
      summary: {
        targetPath: discovery.targetPath,
        fileLimit: limit,
        entryLimit: MAX_WORKSPACE_DIAGNOSTIC_ENTRIES,
        entriesVisited: discovery.entriesVisited,
        selectedFiles: files.length,
        freshFiles,
        timedOutFiles,
        unavailableFiles,
        skippedFiles,
        diagnostics: countDiagnosticSnapshotDiagnostics(snapshot),
        workspacePullRequests: executionStats.workspacePullRequests,
        workspacePullFailures: executionStats.workspacePullFailures,
        workspacePullFiles: executionStats.workspacePullFiles.size,
        documentRefreshFiles: executionStats.documentRefreshFiles.size,
        ignoredDirectories: discovery.ignoredDirectories,
        symlinksSkipped: discovery.symlinksSkipped,
        boundaryEntriesSkipped: discovery.boundaryEntriesSkipped,
        walkErrors: discovery.walkErrors,
        fileLimitReached: discovery.fileLimitReached,
        entryLimitReached: discovery.entryLimitReached,
        traversalComplete,
        complete,
        durationMs: Date.now() - startedAt,
      },
    };
  }

  private async executeWorkspaceDiagnosticPlans(
    discovery: WorkspaceDiagnosticDiscovery,
    plansByClient: Map<LspClient, WorkspaceDiagnosticFilePlan[]>,
    clientResults: Map<LspClient, Map<string, WorkspaceDiagnosticClientFileResult>>,
    stats: WorkspaceDiagnosticExecutionStats,
    options: WorkspaceDiagnosticsOptions,
  ): Promise<void> {
    const entries = [...plansByClient.entries()];
    const documentRefreshPermits = new AsyncPermitPool(this.diagnosticRefreshConcurrency);
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        throwIfAborted(options.signal);
        const entry = entries[nextIndex++];
        if (!entry) return;
        const [client, plans] = entry;
        this.workspaceDiagnosticClients.add(client);
        try {
          const resultByFile = new Map<string, WorkspaceDiagnosticClientFileResult>();
          clientResults.set(client, resultByFile);
          const pull = await client.pullWorkspaceDiagnostics({
            uris: new Set(plans.map((plan) => plan.uri)),
            timeoutMs: options.timeoutMs,
            settleMs: options.settleMs,
            signal: options.signal,
          });
          if (pull.attempted) {
            stats.workspacePullRequests += 1;
            if (pull.outcome !== "fresh") stats.workspacePullFailures += 1;
          }

          const coveredUris = pull.outcome === "fresh" ? pull.coveredUris : new Set<string>();
          const fallbackPlans: WorkspaceDiagnosticFallbackPlan[] = [];
          for (const plan of plans) {
            const source = readWorkspaceDiagnosticSource(discovery, plan.filePath, DEFAULT_LSP_SOURCE_FILE_MAX_BYTES);
            if (source.content === undefined) {
              if (coveredUris.has(plan.uri)) client.invalidateDiagnosticsForFile(plan.filePath);
              resultByFile.set(plan.filePath, {
                outcome: "unavailable",
                reason: `source could not be revalidated during workspace diagnostics: ${workspaceSourceSkipReason(source)}`,
              });
              continue;
            }

            const currentContentHash = contentHash(source.content);
            if (coveredUris.has(plan.uri) && currentContentHash === plan.contentHash) {
              resultByFile.set(plan.filePath, {
                outcome: "fresh",
                snapshot: client.snapshotForUri(plan.uri),
                contentHash: currentContentHash,
                protocol: "workspace-pull",
              });
              stats.workspacePullFiles.add(plan.filePath);
            } else {
              if (coveredUris.has(plan.uri)) client.invalidateDiagnosticsForFile(plan.filePath);
              fallbackPlans.push({ plan, content: source.content, contentHash: currentContentHash });
              stats.documentRefreshFiles.add(plan.filePath);
            }
          }

          await Promise.all(fallbackPlans.map(async (fallback) => {
            const { plan } = fallback;
            try {
              const refresh = await documentRefreshPermits.run(
                () => this.enqueueDiagnosticRefresh(plan.filePath, fallback.content, [client], {
                  timeoutMs: options.timeoutMs,
                  settleMs: options.settleMs,
                  snapshotScope: "file",
                  forceFresh: true,
                  server: options.server,
                  signal: options.signal,
                }),
                options.signal,
              );

              if (refresh?.fresh) {
                const source = readWorkspaceDiagnosticSource(discovery, plan.filePath, DEFAULT_LSP_SOURCE_FILE_MAX_BYTES);
                if (source.content === undefined || contentHash(source.content) !== fallback.contentHash) {
                  client.invalidateDiagnosticsForFile(plan.filePath);
                  resultByFile.set(plan.filePath, {
                    outcome: "unavailable",
                    reason: source.content === undefined
                      ? `source could not be revalidated after diagnostic refresh: ${workspaceSourceSkipReason(source)}`
                      : "source file changed during diagnostic refresh",
                  });
                  return;
                }
              }

              resultByFile.set(plan.filePath, refresh
                ? {
                    outcome: refresh.fresh ? "fresh" : refresh.timedOut ? "timed-out" : "unavailable",
                    ...(refresh.fresh ? { snapshot: refresh.snapshot } : {}),
                    ...(refresh.fresh ? { contentHash: fallback.contentHash, protocol: "document-refresh" as const } : {}),
                    ...(!refresh.fresh && !refresh.timedOut ? { reason: "diagnostic refresh was not authoritative" } : {}),
                  }
                : {
                    outcome: "unavailable",
                    reason: "language server did not produce a diagnostic refresh",
                  });
            } catch (error) {
              if (isCancellation(error, options.signal)) throw error;
              resultByFile.set(plan.filePath, {
                outcome: "unavailable",
                reason: errorMessage(error),
              });
            }
          }));
        } catch (error) {
          if (isCancellation(error, options.signal)) throw error;
          this.markClientInstanceError(plans[0]?.filePath ?? this.projectRoot, client, error);
          const reason = errorMessage(error);
          const resultByFile = clientResults.get(client) ?? new Map<string, WorkspaceDiagnosticClientFileResult>();
          clientResults.set(client, resultByFile);
          for (const plan of plans) {
            if (!resultByFile.has(plan.filePath)) resultByFile.set(plan.filePath, { outcome: "unavailable", reason });
          }
        } finally {
          this.workspaceDiagnosticClients.delete(client);
          this.armIdleTimer();
          this.scheduleResourcePump();
        }
      }
    };

    const workerCount = Math.min(entries.length, this.maxActiveClients, Math.max(1, this.initializationConcurrency));
    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  private revalidateWorkspaceDiagnosticResults(
    discovery: WorkspaceDiagnosticDiscovery,
    plans: WorkspaceDiagnosticFilePlan[],
    clientResults: Map<LspClient, Map<string, WorkspaceDiagnosticClientFileResult>>,
    stats: WorkspaceDiagnosticExecutionStats,
    signal?: AbortSignal,
  ): void {
    for (const plan of plans) {
      throwIfAborted(signal);
      const freshResults: Array<{
        client: LspClient;
        resultByFile: Map<string, WorkspaceDiagnosticClientFileResult>;
        result: WorkspaceDiagnosticClientFileResult;
      }> = [];
      for (const client of plan.clients) {
        const resultByFile = clientResults.get(client);
        const result = resultByFile?.get(plan.filePath);
        if (resultByFile && result?.outcome === "fresh") freshResults.push({ client, resultByFile, result });
      }
      if (freshResults.length === 0) continue;

      const source = readWorkspaceDiagnosticSource(discovery, plan.filePath, DEFAULT_LSP_SOURCE_FILE_MAX_BYTES);
      const currentContentHash = source.content === undefined ? undefined : contentHash(source.content);
      for (const { client, resultByFile, result } of freshResults) {
        if (currentContentHash !== undefined && result.contentHash === currentContentHash) continue;
        client.invalidateDiagnosticsForFile(plan.filePath);
        resultByFile.set(plan.filePath, {
          outcome: "unavailable",
          reason: source.content === undefined
            ? `source could not be revalidated after workspace diagnostics: ${workspaceSourceSkipReason(source)}`
            : "source file changed after its diagnostic refresh",
        });
      }
    }

    stats.workspacePullFiles.clear();
    for (const plan of plans) {
      if (plan.clients.some((client) => {
        const result = clientResults.get(client)?.get(plan.filePath);
        return result?.outcome === "fresh" && result.protocol === "workspace-pull";
      })) {
        stats.workspacePullFiles.add(plan.filePath);
      }
    }
  }

  cachedDiagnostics(pathOrAll?: string, server?: string): DiagnosticSnapshot {
    if (server !== undefined) this.assertKnownServerSelector(server);
    if (!pathOrAll || pathOrAll === "all") return this.snapshotAll(server);

    const resolved = path.resolve(this.projectRoot, pathOrAll);
    const uri = filePathToUri(resolved);
    return this.cachedDiagnosticsForUri(uri, server);
  }

  cachedDiagnosticsIfKnown(
    filePath: string,
    server?: string,
    snapshotScope: DiagnosticSnapshotScope = "file",
  ): DiagnosticSnapshot | undefined {
    const resolved = path.resolve(this.projectRoot, filePath);
    const uri = filePathToUri(resolved);
    const clients = this.cachedClientsForFile(resolved, server);
    if (!clients) return undefined;

    return diagnosticSnapshotForClients(clients, uri, snapshotScope);
  }

  private cachedDiagnosticsForUri(uri: string, server?: string): DiagnosticSnapshot {
    const diagnostics = [...this.clients.values()]
      .filter((client) => server === undefined || client.id === server)
      .flatMap((client) => client.diagnosticsForUri(uri));
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

  notifyFileMutations(mutations: readonly LspFileMutation[]): void {
    const normalized = normalizeFileMutations(mutations, this.projectRoot);
    if (normalized.length === 0) return;
    if (normalized.some((mutation) => lspFileMutationPaths(mutation).some((filePath) => this.rootMarkerNames.has(path.basename(filePath))))) {
      this.rootCache.clear();
    }

    let notified = false;
    for (const client of this.clients.values()) {
      if (client.getStatus().state !== "ready") continue;
      const relevant = normalized.filter((mutation) => (
        lspFileMutationPaths(mutation).some((filePath) => isInsideOrEqual(filePath, client.root))
      ));
      if (relevant.length === 0) continue;
      notified = client.notifyFileMutations(relevant) || notified;
    }
    if (notified) this.armIdleTimer();
  }

  async reconcileOpenDocuments(options: OpenDocumentReconciliationOptions = {}): Promise<OpenDocumentReconciliationResult> {
    throwIfAborted(options.signal);
    const candidates = new Map<string, Array<{ client: LspClient; document: OpenDocumentState }>>();
    for (const client of this.clients.values()) {
      if (client.getStatus().state !== "ready") continue;
      for (const document of client.openDocumentsForReconciliation()) {
        const filePath = path.resolve(document.filePath);
        if (!isInsideOrEqual(filePath, this.projectRoot)) continue;
        const entries = candidates.get(filePath) ?? [];
        entries.push({ client, document });
        candidates.set(filePath, entries);
      }
    }

    const limit = normalizeOpenDocumentReconciliationLimit(options.limit);
    const candidatePaths = [...candidates.keys()].sort((left, right) => left.localeCompare(right));
    const selectionStart = candidatePaths.length === 0 ? 0 : this.openDocumentReconciliationCursor % candidatePaths.length;
    const selected = circularSlice(candidatePaths, selectionStart, limit);
    const mutations: LspFileMutation[] = [];
    const readableChanges = new Map<string, string>();
    const closePaths = new Set<string>();
    let inspectedFiles = 0;
    let skippedFiles = 0;
    let bytesRead = 0;
    let byteLimitReached = false;
    let processedFiles = 0;
    const projectRealRoot = selected.length > 0
      ? realpathIfExists(this.projectRoot) ?? this.projectRoot
      : this.projectRoot;

    for (const filePath of selected) {
      throwIfAborted(options.signal);
      let descriptor: number;
      try {
        descriptor = fs.openSync(
          filePath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
      } catch (error) {
        inspectedFiles += 1;
        processedFiles += 1;
        if (isErrorCode(error, "ENOENT")) {
          mutations.push({ type: "deleted", filePath });
        } else {
          mutations.push({ type: "changed", filePath });
          closePaths.add(filePath);
          skippedFiles += 1;
        }
        continue;
      }

      let processedThisFile = true;
      try {
        inspectedFiles += 1;
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || !openedFileHasExpectedProjectPath(descriptor, filePath, this.projectRoot, projectRealRoot)) {
          mutations.push({ type: "changed", filePath });
          closePaths.add(filePath);
          skippedFiles += 1;
          continue;
        }
        if (stat.size > MAX_RECONCILED_OPEN_DOCUMENT_BYTES) {
          mutations.push({ type: "changed", filePath });
          closePaths.add(filePath);
          skippedFiles += 1;
          continue;
        }
        if (bytesRead + stat.size > MAX_RECONCILED_OPEN_DOCUMENT_TOTAL_BYTES) {
          byteLimitReached = true;
          processedThisFile = false;
          break;
        }

        const bytes = readDescriptorUpTo(descriptor, MAX_RECONCILED_OPEN_DOCUMENT_BYTES + 1);
        if (bytes.length > MAX_RECONCILED_OPEN_DOCUMENT_BYTES) {
          mutations.push({ type: "changed", filePath });
          closePaths.add(filePath);
          skippedFiles += 1;
          continue;
        }
        const content = bytes.toString("utf8");
        if (content.includes("\0")) {
          mutations.push({ type: "changed", filePath });
          closePaths.add(filePath);
          skippedFiles += 1;
          continue;
        }

        bytesRead += bytes.length;
        const changed = candidates.get(filePath)?.some(({ document }) => document.content !== content) ?? false;
        if (!changed) continue;
        mutations.push({ type: "changed", filePath });
        readableChanges.set(filePath, content);
      } catch {
        mutations.push({ type: "changed", filePath });
        closePaths.add(filePath);
        skippedFiles += 1;
      } finally {
        try {
          fs.closeSync(descriptor);
        } catch {
          // The reconciliation result is already determined.
        }
        if (processedThisFile) processedFiles += 1;
      }
    }

    if (candidatePaths.length > 0) {
      this.openDocumentReconciliationCursor = (selectionStart + processedFiles) % candidatePaths.length;
    } else {
      this.openDocumentReconciliationCursor = 0;
    }

    this.notifyFileMutations(mutations);
    let resynchronizedDocuments = 0;
    for (const [filePath, content] of readableChanges) {
      for (const { client } of candidates.get(filePath) ?? []) {
        if (client.reconcileOpenDocument(filePath, content)) resynchronizedDocuments += 1;
      }
    }

    let closedDocuments = mutations
      .filter((mutation) => mutation.type === "deleted")
      .reduce((count, mutation) => count + (candidates.get(mutation.filePath)?.length ?? 0), 0);
    for (const filePath of closePaths) {
      for (const { client } of candidates.get(filePath) ?? []) {
        client.forgetDocument(filePath);
        closedDocuments += 1;
      }
    }

    if (mutations.length > 0) this.armIdleTimer();
    return {
      candidateFiles: candidates.size,
      inspectedFiles,
      changedFiles: mutations.filter((mutation) => mutation.type === "changed").length,
      deletedFiles: mutations.filter((mutation) => mutation.type === "deleted").length,
      skippedFiles,
      resynchronizedDocuments,
      closedDocuments,
      bytesRead,
      fileLimitReached: candidates.size > selected.length,
      byteLimitReached,
      mutations,
    };
  }

  snapshotAll(server?: string): DiagnosticSnapshot {
    const diagnostics = [...this.clients.values()]
      .filter((client) => server === undefined || client.id === server)
      .flatMap((client) => flattenDiagnosticSnapshot(client.snapshot()));
    return createDiagnosticSnapshot(diagnostics);
  }

  async capabilities(filePath?: string, signal?: AbortSignal, server?: string): Promise<unknown> {
    throwIfAborted(signal);
    if (!filePath) {
      return this.getStatus(server);
    }
    const clients = this.getOrCreateClients(path.resolve(this.projectRoot, filePath), server, server !== undefined);
    if (clients.length === 0) return undefined;

    const servers = await Promise.all(clients.map(async (client) => {
      try {
        await client.start(signal);
        return { serverId: client.id, capabilities: client.getCapabilities() };
      } catch (error) {
        if (isCancellation(error, signal)) throw error;
        return { serverId: client.id, error: errorMessage(error) };
      }
    }));
    return servers.length === 1 && !servers[0].error ? servers[0].capabilities : { servers };
  }

  async hover(filePath: string, target: ExternalPositionTarget, signal?: AbortSignal, server?: string): Promise<unknown> {
    const document = this.positionedDocument(filePath, target, "hover");
    const results = await this.documentRequestsForContent(document.filePath, document.content, "textDocument/hover", { position: document.position }, signal, server);
    return results.map((result) => result.result).find(hasHoverContent);
  }

  async definition(filePath: string, target: ExternalPositionTarget, signal?: AbortSignal, server?: string): Promise<unknown> {
    const document = this.positionedDocument(filePath, target, "definition");
    return mergeArrayLikeResults(await this.documentRequestsForContent(document.filePath, document.content, "textDocument/definition", { position: document.position }, signal, server));
  }

  async references(filePath: string, target: ExternalPositionTarget, signal?: AbortSignal, server?: string): Promise<unknown> {
    const document = this.positionedDocument(filePath, target, "references");
    return mergeArrayLikeResults(await this.documentRequestsForContent(document.filePath, document.content, "textDocument/references", { position: document.position, context: { includeDeclaration: true } }, signal, server));
  }

  async implementation(filePath: string, target: ExternalPositionTarget, signal?: AbortSignal, server?: string): Promise<unknown> {
    const document = this.positionedDocument(filePath, target, "implementation");
    return mergeArrayLikeResults(await this.documentRequestsForContent(document.filePath, document.content, "textDocument/implementation", { position: document.position }, signal, server));
  }

  async typeDefinition(filePath: string, target: ExternalPositionTarget, signal?: AbortSignal, server?: string): Promise<unknown> {
    const document = this.positionedDocument(filePath, target, "type definition");
    return mergeArrayLikeResults(await this.documentRequestsForContent(document.filePath, document.content, "textDocument/typeDefinition", { position: document.position }, signal, server));
  }

  async documentSymbols(filePath: string, signal?: AbortSignal, server?: string): Promise<unknown> {
    return mergeArrayResults(await this.documentRequests(filePath, "textDocument/documentSymbol", {}, signal, server));
  }

  async workspaceSymbols(query: unknown, filePath?: string, signal?: AbortSignal, server?: string): Promise<unknown> {
    throwIfAborted(signal);
    if (typeof query !== "string") throw new Error("workspace_symbols requires query");
    const clients = filePath
      ? this.getOrCreateClients(path.resolve(this.projectRoot, filePath), server, server !== undefined, true)
      : this.readyOrAnyClients(server, true);
    if (clients.length === 0) throw new Error(server
      ? `No active LSP client for server ${JSON.stringify(server)}. Pass path to choose and start that language server.`
      : "No active LSP client. Open a file with lsp diagnostics first, or pass path to choose a language server.");
    return mergeArrayResults(await this.clientRequests(clients, "workspace/symbol", { query }, signal));
  }

  async codeActions(filePath: string, target: ExternalPositionTarget, signal?: AbortSignal, server?: string): Promise<unknown> {
    const document = this.positionedDocument(filePath, target, "code actions");
    const range = oneLineLspRange(document.position);
    const resolved = document.filePath;
    const content = document.content;

    await this.diagnosticsForFileDetailed(resolved, content, {
      timeoutMs: EXPLICIT_LSP_DIAGNOSTIC_TIMEOUT_MS,
      settleMs: 0,
      snapshotScope: "file",
      forceFresh: true,
      server,
      signal,
    }).catch((error) => {
      if (isCancellation(error, signal)) throw error;
      return undefined;
    });

    const clients = this.getOrCreateClients(resolved, server, server !== undefined);
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

  async rename(filePath: string, target: ExternalPositionTarget, newName: unknown, signal?: AbortSignal, server?: string): Promise<unknown> {
    if (typeof newName !== "string" || newName.length === 0) throw new Error("rename requires newName");
    const document = this.positionedDocument(filePath, target, "rename");
    const { result, client } = await this.documentRequest(document.filePath, document.content, "textDocument/rename", { position: document.position, newName }, signal, server);
    return decorateWorkspaceEdit(client, result);
  }

  async prepareFileRename(oldFilePath: string, newFilePath: string, signal?: AbortSignal, server?: string): Promise<unknown> {
    throwIfAborted(signal);
    const rename = resolveFileRenameOperation(oldFilePath, newFilePath, this.projectRoot);
    if (!rename.ok) throw new Error(rename.reason);

    const content = readLspSourceFile(rename.oldFilePath);
    const client = this.getOrCreateSingleClient(rename.oldFilePath, server);
    if (!client) throw new Error(`No semantic language server configured for ${rename.oldFilePath}`);

    await client.start(signal);
    if (!client.canRenameFiles(rename.oldFilePath, rename.newFilePath)) {
      throw new Error(`Language server ${JSON.stringify(client.id)} does not support workspace/willRenameFiles for ${rename.oldFilePath}`);
    }

    const result = await client.requestForDocument(rename.oldFilePath, content, "workspace/willRenameFiles", {
      files: [{
        oldUri: filePathToUri(rename.oldFilePath),
        newUri: filePathToUri(rename.newFilePath),
      }],
    }, 10_000, signal);
    if (result !== null && result !== undefined && !isRecord(result)) {
      throw new Error(`Language server ${JSON.stringify(client.id)} returned a malformed workspace/willRenameFiles result`);
    }
    this.armIdleTimer();
    return decorateWorkspaceEdit(client, result ?? { changes: {} });
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

  getStatus(server?: string): LspServiceStatus {
    if (server !== undefined) this.assertKnownServerSelector(server);
    const clients = [...this.clients.values()]
      .filter((client) => server === undefined || client.id === server)
      .map((client) => client.getStatus());
    return {
      activeClients: clients.filter((client) => client.state === "ready" || client.state === "starting").length,
      clients,
      unavailableServers: [...this.unavailableServers.values()].filter((unavailable) => server === undefined || unavailable.id === server),
      serverConfiguration: this.serverConfiguration?.status,
      clientResources: {
        idleTimeoutMs: this.idleTimeoutMs,
        maxActiveClients: this.maxActiveClients,
        initializationConcurrency: this.initializationConcurrency,
        activeClients: this.activeClientCount(),
        initializingClients: this.initializingClients.size,
        queuedStarts: this.startQueue.filter((waiter) => !waiter.settled).length,
        starts: this.clientStartCount,
        restarts: this.clientRestartCount,
        evictions: this.clientEvictionCount,
        idleEvictions: this.idleEvictionCount,
        capacityEvictions: this.capacityEvictionCount,
        initializationCooldowns: this.initializationCooldownCount,
      },
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
    this.startsPaused = true;
    this.cancelStartWaiters("LSP service is restarting");
    const clients = [...new Set([...this.clients.values(), ...this.evictingClients])];
    this.clients.clear();
    this.unavailableServers.clear();
    this.rootCache.clear();
    this.openDocumentReconciliationCursor = 0;
    this.finishDiagnosticRefreshWaiters(undefined);
    try {
      await Promise.allSettled(clients.map((client) => client.shutdown(signal)));
      throwIfAborted(signal);
    } finally {
      this.startsPaused = false;
      this.armIdleTimer();
      this.scheduleResourcePump();
    }
  }

  async shutdownAll(signal?: AbortSignal): Promise<void> {
    this.startsPaused = true;
    this.cancelStartWaiters("LSP service is stopping");
    const clients = [...new Set([...this.clients.values(), ...this.evictingClients])];
    this.clients.clear();
    this.unavailableServers.clear();
    this.rootCache.clear();
    this.openDocumentReconciliationCursor = 0;
    this.finishDiagnosticRefreshWaiters(undefined);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    try {
      await Promise.allSettled(clients.map((client) => client.shutdown(signal)));
    } finally {
      this.startsPaused = false;
      this.scheduleResourcePump();
    }
  }

  private positionedDocument(filePath: string, target: ExternalPositionTarget, operation: string): PositionedDocument {
    const resolved = path.resolve(this.projectRoot, filePath);
    const content = readLspSourceFile(resolved);
    try {
      return {
        filePath: resolved,
        content,
        position: resolveExternalPositionTarget(content, target),
      };
    } catch (error) {
      const message = errorMessage(error);
      throw new Error(`${operation} ${message}`);
    }
  }

  private async documentRequest(
    filePath: string,
    content: string,
    method: string,
    extraParams: Record<string, unknown>,
    signal?: AbortSignal,
    server?: string,
  ): Promise<{ result: unknown; client: LspClient }> {
    throwIfAborted(signal);
    const resolved = path.resolve(filePath);

    const client = this.getOrCreateSingleClient(resolved, server);
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
    const key = diagnosticRefreshKey(filePath, content, clients);

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
      // multiple files at once. Concurrent pull requests or older
      // publishDiagnostics responses can otherwise race newer content.
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
      fresh: successful.length === clients.length && successful.every((result) => result.fresh),
      timedOut: successful.some((result) => result.timedOut),
      requestedAt: Math.min(...successful.map((result) => result.requestedAt)),
      completedAt: Math.max(...successful.map((result) => result.completedAt)),
    };
  }

  private armDiagnosticWaiterTimeout(job: DiagnosticRefreshJob, waiter: DiagnosticRefreshWaiter): void {
    waiter.timeout = setTimeout(() => {
      this.resolveDiagnosticWaiter(job, waiter, timedOutDiagnosticRefresh(job, waiter));
    }, Math.max(0, waiter.options.timeoutMs));
    waiter.timeout.unref();
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

  private async documentRequests(
    filePath: string,
    method: string,
    extraParams: Record<string, unknown>,
    signal?: AbortSignal,
    server?: string,
  ): Promise<ClientRequestResult[]> {
    throwIfAborted(signal);
    const resolved = path.resolve(this.projectRoot, filePath);
    const content = readLspSourceFile(resolved);

    return this.documentRequestsForContent(resolved, content, method, extraParams, signal, server);
  }

  private async documentRequestsForContent(
    filePath: string,
    content: string,
    method: string,
    extraParams: Record<string, unknown>,
    signal?: AbortSignal,
    server?: string,
  ): Promise<ClientRequestResult[]> {
    throwIfAborted(signal);
    const resolved = path.resolve(filePath);

    const clients = this.getOrCreateClients(resolved, server, server !== undefined, true);
    if (clients.length === 0) throw new Error(`No semantic language server configured for ${resolved}`);

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
        return { client, error: errorMessage(error) };
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
    const clients: LspClient[] = [];

    for (const resolvedServer of this.resolveServers(resolved)) {
      if (!resolvedServer.available) continue;
      const client = this.clients.get(clientKey(resolvedServer.root, resolvedServer.definition));
      if (client) clients.push(client);
    }

    return clients;
  }

  private getOrCreateSingleClient(filePath: string, server?: string): LspClient | undefined {
    const clients = this.getOrCreateClients(filePath, server, server !== undefined, true);
    if (clients.length > 1 && server === undefined) {
      throw new Error(`Multiple language servers support ${path.resolve(filePath)}: ${clients.map((client) => client.id).join(", ")}. Pass server to select one.`);
    }
    return clients[0];
  }

  private getOrCreateClients(filePath: string, server?: string, requireSelected = false, semanticOnly = false): LspClient[] {
    const resolved = path.resolve(filePath);
    const clients: LspClient[] = [];
    const resolvedServers = this.resolveServers(resolved, server, semanticOnly);

    for (const resolvedServer of resolvedServers) {
      if (!resolvedServer.available) {
        this.recordUnavailableServer(resolved, resolvedServer);
        continue;
      }

      const key = clientKey(resolvedServer.root, resolvedServer.definition);
      let client = this.clients.get(key);
      if (!client) {
        let created!: LspClient;
        created = new LspClient(resolvedServer.definition, resolvedServer.root, {
          acquireStartPermit: (signal) => this.acquireClientStartPermit(created, signal),
          onResourceChange: () => this.onClientResourceChange(),
          onLifecycleEvent: (event) => this.recordClientLifecycleEvent(event),
        });
        client = created;
        this.clients.set(key, client);
        this.armIdleTimer();
      }
      this.forgetDocumentFromOtherRoots(resolved, client);
      clients.push(client);
    }

    if (server !== undefined && requireSelected && clients.length === 0) {
      const reasons = resolvedServers.map((resolvedServer) => resolvedServer.unavailableReason).filter(Boolean);
      throw new Error(`Language server ${JSON.stringify(server)} is unavailable for ${resolved}: ${reasons.join("; ") || "no available route"}`);
    }
    return clients;
  }

  private cachedClientsForFile(filePath: string, server?: string): LspClient[] | undefined {
    const resolved = path.resolve(filePath);
    const uri = filePathToUri(resolved);
    const clients: LspClient[] = [];

    for (const resolvedServer of this.resolveServers(resolved, server)) {
      if (!resolvedServer.available) continue;
      const key = clientKey(resolvedServer.root, resolvedServer.definition);
      const client = this.clients.get(key);
      if (!client || !client.hasDiagnosticsForUri(uri)) return undefined;
      clients.push(client);
    }

    return clients.length > 0 ? clients : undefined;
  }

  private resolveServers(filePath: string, server?: string, semanticOnly = false): ResolvedLanguageServer[] {
    if (server !== undefined) this.assertKnownServerSelector(server);

    const root = this.workspaceBoundaryForFile(filePath);
    const resolved = resolveLanguageServers(filePath, {
      serverOverrides: this.serverOverrides,
      serverConfiguration: this.serverConfiguration?.servers,
      projectRoot: root,
      trustedEnvironmentRoots: this.trustedEnvironmentRoots,
      server,
      rootCache: this.rootCache,
    });
    const routed = semanticOnly && server === undefined
      ? resolved.filter((entry) => entry.definition.role === "language")
      : resolved;
    if (server === undefined || routed.length > 0) return routed;

    const configured = this.serverConfiguration?.servers[server];
    if (configured?.disabled) throw new Error(`Language server ${JSON.stringify(server)} is disabled by config.`);

    throw new Error(`Language server ${JSON.stringify(server)} does not support ${path.resolve(filePath)}.`);
  }

  private assertKnownServerSelector(server: string): void {
    if (server.length === 0 || server.trim() !== server) {
      throw new Error("Language server selector must not be blank or contain surrounding whitespace.");
    }
    const serverIds = configuredLanguageServerIds(this.serverConfiguration?.servers);
    if (!serverIds.includes(server)) {
      throw new Error(`Unknown language server ${JSON.stringify(server)}. Configured server ids: ${serverIds.join(", ")}.`);
    }
  }

  private recordUnavailableServer(filePath: string, resolvedServer: ResolvedLanguageServer): void {
    this.unavailableServers.set(unavailableServerKey(resolvedServer.definition.id, resolvedServer.root), {
      id: resolvedServer.definition.id,
      command: resolvedServer.definition.command,
      filePath,
      reason: resolvedServer.unavailableReason ?? "unavailable",
    });
  }

  private workspaceBoundaryForFile(filePath: string): string {
    return resolveWorkspaceRootForPath(filePath, this.projectRoot, this.trustedEnvironmentRoots);
  }

  private readyOrAnyClients(server?: string, semanticOnly = false): LspClient[] {
    if (server !== undefined) this.assertKnownServerSelector(server);
    const clients = [...this.clients.values()]
      .filter((client) => server === undefined || client.id === server)
      .filter((client) => !semanticOnly || server !== undefined || client.definition.role === "language");
    const ready = clients.filter((client) => client.getStatus().state === "ready");
    return ready.length > 0 ? ready : clients;
  }

  private markClientInstanceError(filePath: string, client: LspClient, error: unknown): void {
    const status = client.getStatus();
    this.unavailableServers.set(unavailableServerKey(status.id, client.root), {
      id: status.id,
      command: status.command,
      filePath,
      reason: errorMessage(error),
    });
  }

  private forgetDocumentFromOtherRoots(filePath: string, selected: LspClient): void {
    for (const client of this.clients.values()) {
      if (client === selected || client.id !== selected.id || client.root === selected.root) continue;
      client.forgetDocument(filePath);
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.idleTimeoutMs <= 0 || this.clients.size === 0) return;

    const now = Date.now();
    let nextDeadline = Number.POSITIVE_INFINITY;
    for (const client of this.clients.values()) {
      if (client.hasActiveWork()) continue;
      const retryAt = client.getStatus().initializationRetryAt ?? 0;
      const deadline = Math.max(client.getLastActivityAt() + this.idleTimeoutMs, retryAt);
      nextDeadline = Math.min(nextDeadline, deadline);
    }
    if (!Number.isFinite(nextDeadline)) return;

    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.evictIdleClients();
    }, Math.max(0, nextDeadline - now));
    this.idleTimer.unref();
  }

  private async evictIdleClients(): Promise<void> {
    if (this.idleSweepRunning || this.idleTimeoutMs <= 0) return;
    this.idleSweepRunning = true;
    try {
      const now = Date.now();
      const candidates = [...this.clients.values()]
        .filter((client) => this.canEvictClient(client))
        .filter((client) => {
          const retryAt = client.getStatus().initializationRetryAt ?? 0;
          return retryAt <= now && client.getLastActivityAt() + this.idleTimeoutMs <= now;
        })
        .sort((left, right) => left.getLastActivityAt() - right.getLastActivityAt());
      for (const client of candidates) await this.evictClient(client, "idle");
    } finally {
      this.idleSweepRunning = false;
      this.armIdleTimer();
      this.scheduleResourcePump();
    }
  }

  private acquireClientStartPermit(client: LspClient, signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (this.startsPaused) return Promise.reject(transientResourceError("LSP service is stopping"));

    return new Promise((resolve, reject) => {
      const waiter: ClientStartWaiter = { client, resolve, reject, signal, settled: false };
      if (signal) {
        waiter.onAbort = () => this.rejectClientStartWaiter(waiter, abortError(signal));
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.startQueue.push(waiter);
      if (signal?.aborted) waiter.onAbort?.();
      this.scheduleResourcePump();
    });
  }

  private scheduleResourcePump(): void {
    this.resourcePumpRequested = true;
    if (this.resourcePumpRunning || this.resourcePumpScheduled) return;
    this.resourcePumpScheduled = true;
    queueMicrotask(() => {
      this.resourcePumpScheduled = false;
      void this.runResourcePump();
    });
  }

  private async runResourcePump(): Promise<void> {
    if (this.resourcePumpRunning) return;
    this.resourcePumpRunning = true;
    try {
      while (this.resourcePumpRequested) {
        this.resourcePumpRequested = false;
        await this.rebalanceClientBudget();
        await this.grantClientStartPermits();
      }
    } finally {
      this.resourcePumpRunning = false;
      this.armIdleTimer();
      if (this.resourcePumpRequested) this.scheduleResourcePump();
    }
  }

  private async rebalanceClientBudget(): Promise<void> {
    while (this.activeClientCount() > this.maxActiveClients) {
      const victim = this.leastRecentlyUsedEvictableClient();
      if (!victim || !await this.evictClient(victim, "capacity")) return;
    }
  }

  private async grantClientStartPermits(): Promise<void> {
    while (!this.startsPaused && this.initializingClients.size < this.initializationConcurrency) {
      const waiter = this.takeNextClientStartWaiter();
      if (!waiter) return;

      while (this.activeClientCount() >= this.maxActiveClients) {
        const victim = this.leastRecentlyUsedEvictableClient(waiter.client);
        if (!victim) {
          this.startQueue.unshift(waiter);
          return;
        }
        if (!await this.evictClient(victim, "capacity")) {
          this.startQueue.unshift(waiter);
          return;
        }
      }

      this.initializingClients.add(waiter.client);
      this.resolveClientStartWaiter(waiter, this.clientStartPermitRelease(waiter.client));
    }
  }

  private takeNextClientStartWaiter(): ClientStartWaiter | undefined {
    while (this.startQueue.length > 0) {
      const waiter = this.startQueue.shift();
      if (!waiter || waiter.settled) continue;
      if (waiter.signal?.aborted) {
        this.rejectClientStartWaiter(waiter, abortError(waiter.signal));
        continue;
      }
      return waiter;
    }
    return undefined;
  }

  private clientStartPermitRelease(client: LspClient): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.initializingClients.delete(client);
      this.onClientResourceChange();
    };
  }

  private resolveClientStartWaiter(waiter: ClientStartWaiter, release: () => void): void {
    if (waiter.settled) {
      release();
      return;
    }
    waiter.settled = true;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(release);
  }

  private rejectClientStartWaiter(waiter: ClientStartWaiter, error: Error): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.reject(error);
    this.scheduleResourcePump();
  }

  private cancelStartWaiters(message: string): void {
    const error = transientResourceError(message);
    const waiters = this.startQueue.splice(0);
    for (const waiter of waiters) this.rejectClientStartWaiter(waiter, error);
  }

  private activeClientCount(): number {
    const active = new Set<LspClient>([...this.initializingClients, ...this.evictingClients]);
    for (const client of [...this.clients.values(), ...this.evictingClients]) {
      const state = client.getStatus().state;
      if (state === "ready" || state === "starting") active.add(client);
    }
    return active.size;
  }

  private leastRecentlyUsedEvictableClient(exclude?: LspClient): LspClient | undefined {
    return [...this.clients.values()]
      .filter((client) => client !== exclude && client.getStatus().state === "ready" && this.canEvictClient(client))
      .sort((left, right) => left.getLastActivityAt() - right.getLastActivityAt())[0];
  }

  private canEvictClient(client: LspClient): boolean {
    return !client.hasActiveWork() &&
      !this.clientHasQueuedDiagnosticRefresh(client) &&
      !this.workspaceDiagnosticClients.has(client) &&
      !this.evictingClients.has(client);
  }

  private clientHasQueuedDiagnosticRefresh(client: LspClient): boolean {
    return [...this.queuedDiagnosticRefreshes.values()].some((job) => job.clients.includes(client));
  }

  private async evictClient(client: LspClient, reason: ClientEvictionReason): Promise<boolean> {
    if (!this.canEvictClient(client)) return false;
    const entry = [...this.clients.entries()].find(([, candidate]) => candidate === client);
    if (!entry) return false;

    this.clients.delete(entry[0]);
    this.evictingClients.add(client);
    try {
      await client.shutdown();
      this.clientEvictionCount += 1;
      if (reason === "idle") this.idleEvictionCount += 1;
      else this.capacityEvictionCount += 1;
      return true;
    } finally {
      this.evictingClients.delete(client);
      this.scheduleResourcePump();
    }
  }

  private onClientResourceChange(): void {
    this.scheduleResourcePump();
  }

  private recordClientLifecycleEvent(event: "start" | "restart" | "cooldown"): void {
    if (event === "start") this.clientStartCount += 1;
    else if (event === "restart") this.clientRestartCount += 1;
    else this.initializationCooldownCount += 1;
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
    forceFresh: left.forceFresh === true || right.forceFresh === true,
    server: left.server ?? right.server,
  };
}

function diagnosticJobOptions(options: DiagnosticsForFileOptions): DiagnosticsForFileOptions {
  return {
    timeoutMs: options.timeoutMs,
    settleMs: options.settleMs,
    snapshotScope: options.snapshotScope,
    forceFresh: options.forceFresh,
    server: options.server,
  };
}

function mergeDiagnosticSnapshotScope(left: DiagnosticSnapshotScope | undefined, right: DiagnosticSnapshotScope | undefined): DiagnosticSnapshotScope | undefined {
  return left === "workspace" || right === "workspace" ? "workspace" : undefined;
}

function canShareRunningDiagnosticJob(job: DiagnosticRefreshJob, options: DiagnosticsForFileOptions): boolean {
  if (options.snapshotScope === "workspace" && job.options.snapshotScope !== "workspace") return false;
  if (options.forceFresh === true && job.options.forceFresh !== true) return false;
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

function diagnosticRefreshKey(filePath: string, content: string, clients: LspClient[]): string {
  const serverIds = clients
    .map((client) => `${client.id}\0${client.root}`)
    .sort((left, right) => left.localeCompare(right))
    .join("\0");
  return `${path.resolve(filePath)}\0${serverIds}\0${content.length}\0${contentHash(content)}`;
}

function normalizeFileMutations(mutations: readonly LspFileMutation[], projectRoot: string): LspFileMutation[] {
  const normalized: LspFileMutation[] = [];
  for (const mutation of mutations) {
    if (mutation.type === "renamed") {
      const oldFilePath = path.resolve(mutation.oldFilePath);
      const newFilePath = path.resolve(mutation.newFilePath);
      if (!isInsideOrEqual(oldFilePath, projectRoot) || !isInsideOrEqual(newFilePath, projectRoot)) continue;
      normalized.push({ type: "renamed", oldFilePath, newFilePath });
      continue;
    }

    const filePath = path.resolve(mutation.filePath);
    if (!isInsideOrEqual(filePath, projectRoot)) continue;
    normalized.push({ type: mutation.type, filePath });
  }
  return normalized;
}

function openedFileHasExpectedProjectPath(
  descriptor: number,
  filePath: string,
  projectRoot: string,
  projectRealRoot: string,
): boolean {
  try {
    const openedRealPath = fs.readlinkSync(`/proc/self/fd/${descriptor}`);
    const expectedRealPath = path.resolve(projectRealRoot, path.relative(projectRoot, filePath));
    return isInsideOrEqual(openedRealPath, projectRealRoot) && path.resolve(openedRealPath) === expectedRealPath;
  } catch {
    return false;
  }
}

function normalizeOpenDocumentReconciliationLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_RECONCILED_OPEN_DOCUMENTS;
  return Math.min(MAX_RECONCILED_OPEN_DOCUMENTS, Math.max(1, Math.floor(value)));
}

function circularSlice<T>(values: readonly T[], start: number, limit: number): T[] {
  if (values.length === 0 || limit <= 0) return [];
  const count = Math.min(values.length, limit);
  return Array.from({ length: count }, (_, index) => values[(start + index) % values.length]);
}

function transientResourceError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
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

function workspaceSourceSkipReason(result: WorkspaceDiagnosticSourceReadResult): string {
  const size = result.size === undefined ? "" : ` (${formatBytes(result.size)})`;
  switch (result.skippedReason) {
    case "too-large":
      return `source file exceeds the ${formatBytes(DEFAULT_LSP_SOURCE_FILE_MAX_BYTES)} limit${size}`;
    case "binary":
      return `source file appears to be binary${size}`;
    case "missing":
      return "source file disappeared during the workspace scan";
    case "not-file":
      return "path is no longer a regular file";
    case "unsafe-path":
      return "source path could not be safely revalidated after workspace discovery";
    default:
      return "source file could not be read";
  }
}

function workspaceDiagnosticUnavailableReason(results: WorkspaceDiagnosticClientFileResult[]): string {
  const reasons = [...new Set(results.map((result) => result.reason).filter((reason): reason is string => reason !== undefined))];
  return reasons.join("; ") || "no language server produced an authoritative diagnostic refresh";
}

function clientKey(root: string, definition: LanguageServerDefinition): string {
  return `${path.resolve(root)}\0${definition.id}\0${definition.command}\0${definition.args.join("\0")}\0${definition.environment?.key ?? ""}\0${definition.configurationKey ?? ""}`;
}

function unavailableServerKey(id: string, root: string): string {
  return `${id}\0${path.resolve(root)}`;
}

export function createLspService(options: LspServiceOptions): LspService {
  return new LspService(options);
}

