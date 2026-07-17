import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { createDiagnosticSnapshot } from "../diagnostics/snapshots.ts";
import { asError, errorMessage } from "../errors.ts";
import { mergeProcessEnv } from "../language-environments.ts";
import { isRecord, type DiagnosticRefreshResult, type DiagnosticSnapshot, type LspClientState, type LspClientStatus, type LspDiagnostic, type LspDiagnosticOutcome, type LspServerLog, type LspServerLogLevel, type RelatedLocation } from "../types.ts";
import { abortError, DIAGNOSTIC_TIMEOUT_ABORT_REASON, isCancellation, throwIfAborted, waitWithSignal } from "./cancellation.ts";
import type { LspFileMutation } from "./file-mutations.ts";
import { filePathToUri, isLspRange, lspRangeToExternal, type LspRange } from "./positions.ts";
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
  outbound?: OutboundMessage;
  signal?: AbortSignal;
  onAbort?: () => void;
}

type OutboundMessageState = "queued" | "writing" | "sent" | "discarded";

interface OutboundMessage {
  child: ChildProcessWithoutNullStreams;
  generation: number;
  payload: string;
  byteLength: number;
  label: string;
  state: OutboundMessageState;
  error?: Error;
  timeout?: NodeJS.Timeout;
  waiters?: Set<OutboundMessageWaiter>;
}

interface OutboundMessageWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface InitializationFailure {
  message: string;
  retryAt: number;
}

interface InitializationAttempt {
  controller: AbortController;
  promise: Promise<void>;
  waiters: number;
}

interface OpenDocument {
  uri: string;
  filePath: string;
  languageId: string;
  version: number;
  content: string;
}

export interface OpenDocumentState {
  filePath: string;
  content: string;
}

interface DiagnosticEntry {
  uri: string;
  version?: number;
  diagnostics: RawLspDiagnostic[];
  receivedAt: number;
  authoritative: boolean;
  provisional?: boolean;
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
  message: string;
  relatedInformation?: RawRelatedInformation[];
}

interface RawRelatedInformation {
  location: {
    uri: string;
    range: LspRange;
  };
  message: string;
}

interface PublishDiagnosticsParams {
  uri?: string;
  diagnostics?: RawLspDiagnostic[];
  version?: number;
}

interface DocumentDiagnosticProvider {
  identifier?: string;
}

interface WorkspaceDiagnosticProvider extends DocumentDiagnosticProvider {
  workspaceDiagnostics: true;
}

interface ParsedDocumentDiagnosticReport {
  diagnostics: RawLspDiagnostic[];
  relatedDocuments: Array<{ uri: string; diagnostics: RawLspDiagnostic[] }>;
  malformed: boolean;
}

interface ParsedDiagnosticItems {
  diagnostics: RawLspDiagnostic[];
  malformed: boolean;
}

interface TsServerDiagnosticResponse {
  diagnostics: RawLspDiagnostic[];
}

interface ParsedWorkspaceDocumentDiagnosticReport {
  uri: string;
  version: number | null;
  kind: "full" | "unchanged";
  resultId?: string;
  diagnostics?: RawLspDiagnostic[];
}

interface WorkspaceDiagnosticReportCollector {
  reports: Map<string, ParsedWorkspaceDocumentDiagnosticReport>;
  reportEntries: number;
  diagnosticEntries: number;
  collectedBytes: number;
  malformed: boolean;
}

type PullDiagnosticOutcome = "authoritative" | "timed-out" | "unavailable" | "malformed";

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
  forceFresh?: boolean;
  signal?: AbortSignal;
}

export type WorkspaceDiagnosticPullOutcome = "fresh" | "timed-out" | "unavailable";

export interface WorkspaceDiagnosticPullResult {
  attempted: boolean;
  outcome: WorkspaceDiagnosticPullOutcome;
  coveredUris: ReadonlySet<string>;
}

export interface WorkspaceDiagnosticPullOptions {
  uris: ReadonlySet<string>;
  timeoutMs: number;
  deadlineAt?: number;
  settleMs: number;
  signal?: AbortSignal;
}

export interface WorkspaceDiagnosticDocument {
  filePath: string;
  content: string;
}

export type WorkspaceDocumentDiagnosticProtocol = "document-pull" | "push-batch";

export interface WorkspaceDocumentDiagnosticResult {
  outcome: "fresh" | "eventual" | "timed-out" | "unavailable";
  protocol: WorkspaceDocumentDiagnosticProtocol;
  snapshot?: DiagnosticSnapshot;
  reason?: string;
  fallbackToPush?: boolean;
}

export interface WorkspaceDocumentDiagnosticsResult {
  files: Map<string, WorkspaceDocumentDiagnosticResult>;
}

export interface WorkspaceDocumentDiagnosticsOptions {
  deadlineAt: number;
  settleMs: number;
  concurrency: number;
  signal?: AbortSignal;
}

interface DeadlineSignal {
  signal: AbortSignal;
  readonly timedOut: boolean;
  dispose(): void;
}

export type DiagnosticSnapshotScope = "file" | "workspace";

const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
const DEFAULT_INITIALIZATION_FAILURE_COOLDOWN_MS = 3 * 60_000;
const DEFAULT_WRITE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_QUEUED_WRITE_BYTES = 16 * 1024 * 1024;
const MAX_INBOUND_HEADER_BYTES = 8 * 1024;
const MAX_INBOUND_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_WORKSPACE_DIAGNOSTIC_REPORT_ENTRIES = 10_000;
const MAX_WORKSPACE_DIAGNOSTIC_ENTRIES = 50_000;
const MAX_WORKSPACE_DIAGNOSTIC_COLLECTED_BYTES = 16 * 1024 * 1024;
const TYPESCRIPT_TSSERVER_REQUEST_COMMAND = "typescript.tsserverRequest";
const TYPESCRIPT_DIAGNOSTIC_COMMANDS = [
  "syntacticDiagnosticsSync",
  "semanticDiagnosticsSync",
  "suggestionDiagnosticsSync",
] as const;
const PUSH_DIAGNOSTIC_REUSE_OBSERVATION_MS = 50;
const PUSH_DIAGNOSTIC_INITIAL_OBSERVATION_MS = 2_000;
const PUSH_DIAGNOSTIC_TIMEOUT_HEADROOM_MS = 50;
const CLOSED_DOCUMENT_DIAGNOSTIC_SUPPRESSION_MS = 1_000;
const PROCESS_KILL_GRACE_MS = 750;
const FILE_CHANGE_CREATED = 1;
const FILE_CHANGE_CHANGED = 2;
const FILE_CHANGE_DELETED = 3;

export interface LspClientOptions {
  initializeTimeoutMs?: number;
  initializationFailureCooldownMs?: number;
  writeTimeoutMs?: number;
  maxQueuedWriteBytes?: number;
  acquireStartPermit?: (signal?: AbortSignal) => Promise<() => void>;
  onResourceChange?: () => void;
  onLifecycleEvent?: (event: "start" | "restart" | "cooldown") => void;
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
  private initializationAttempt?: InitializationAttempt;
  private documents = new Map<string, OpenDocument>();
  private diagnostics = new Map<string, DiagnosticEntry>();
  private suppressedClosedDocumentDiagnostics = new Map<string, number>();
  private workspaceDiagnosticResultIds = new Map<string, string>();
  private diagnosticWaiters = new Map<string, Set<DiagnosticWaiter>>();
  private progressHandlers = new Map<string | number, (value: unknown) => void>();
  private nextProgressToken = 1;
  private workspaceStateGeneration = 0;
  private capabilities: unknown;
  private lastDiagnosticsAt?: number;
  private lastDiagnosticDurationMs?: number;
  private lastDiagnosticOutcome?: LspDiagnosticOutcome;
  private lastError?: string;
  private lastServerLog?: LspServerLog;
  private sessionId?: string;
  private launchGeneration = 0;
  private initializeTimeoutMs: number;
  private initializationFailureCooldownMs: number;
  private initializationFailure?: InitializationFailure;
  private writeTimeoutMs: number;
  private maxQueuedWriteBytes: number;
  private outboundQueue: OutboundMessage[] = [];
  private activeOutbound?: OutboundMessage;
  private outboundBytes = 0;
  private readonly acquireStartPermit?: (signal?: AbortSignal) => Promise<() => void>;
  private readonly onResourceChange?: () => void;
  private readonly onLifecycleEvent?: (event: "start" | "restart" | "cooldown") => void;
  private activeOperations = 0;
  private lastActivityAt = Date.now();
  private startCount = 0;
  private restartCount = 0;
  private initializationCooldownCount = 0;
  private shutdownPromise?: Promise<void>;
  private shuttingDown = false;

  constructor(definition: LanguageServerDefinition, root: string, options: LspClientOptions = {}) {
    this.definition = definition;
    this.id = definition.id;
    this.root = path.resolve(root);
    this.initializeTimeoutMs = Math.max(1, options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS);
    this.initializationFailureCooldownMs = Math.max(0, options.initializationFailureCooldownMs ?? DEFAULT_INITIALIZATION_FAILURE_COOLDOWN_MS);
    this.writeTimeoutMs = Math.max(1, options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS);
    this.maxQueuedWriteBytes = Math.max(1, options.maxQueuedWriteBytes ?? DEFAULT_MAX_QUEUED_WRITE_BYTES);
    this.acquireStartPermit = options.acquireStartPermit;
    this.onResourceChange = options.onResourceChange;
    this.onLifecycleEvent = options.onLifecycleEvent;
  }

  async touchDocumentDetailed(filePath: string, content: string, options: TouchDocumentOptions): Promise<DiagnosticRefreshResult> {
    return this.withActiveOperation(async () => {
      await this.ensureStarted(options.signal);
      throwIfAborted(options.signal);

      const touchedAt = Date.now();
      const uri = filePathToUri(filePath);
      const pullProvider = hasAuthoritativeDocumentDiagnosticRequest(this.capabilities);
      const previousDocument = this.documents.get(uri);
      const hadReusablePushState = !pullProvider && previousDocument?.content === content &&
        isReusablePushDiagnosticEntry(this.diagnostics.get(uri));
      // A failed pull must not let a pre-request pull result satisfy the push
      // fallback as though the server had published after this refresh.
      if (pullProvider) this.invalidateDiagnostics(uri);
      const document = this.syncDocument(filePath, content, options.forceFresh === true && !pullProvider);
      const documentVersion = document.version;

      this.notify("textDocument/didSave", textDocumentDidSaveParams(document.uri, content, this.capabilities));

      let outcome: LspDiagnosticOutcome;
      try {
        const pullOutcome = await this.pullDiagnostics(document, documentVersion, touchedAt, options);
        if (pullOutcome === "authoritative") {
          outcome = "fresh";
        } else if (pullOutcome === "timed-out") {
          outcome = "timeout";
        } else {
          const remaining = remainingDiagnosticTimeout(options.timeoutMs, touchedAt);
          const waitMs = options.forceFresh
            ? Math.min(
                Math.max(0, remaining - PUSH_DIAGNOSTIC_TIMEOUT_HEADROOM_MS),
                pushDiagnosticObservationBudget(hadReusablePushState, options.settleMs),
              )
            : Math.max(0, remaining - PUSH_DIAGNOSTIC_TIMEOUT_HEADROOM_MS);
          const published = await this.waitForDiagnostics(
            document.uri,
            documentVersion,
            touchedAt,
            waitMs,
            options.settleMs,
            options.signal,
          );
          if (published) {
            outcome = "fresh";
          } else if (!pullProvider && pullOutcome === "unavailable" && this.ensureProvisionalPushDiagnostics(document.uri, documentVersion)) {
            outcome = "eventual";
          } else {
            outcome = "unavailable";
          }
        }
      } catch (error) {
        if (isCancellation(error, options.signal)) {
          this.lastDiagnosticDurationMs = Date.now() - touchedAt;
          this.lastDiagnosticOutcome = options.signal?.reason === DIAGNOSTIC_TIMEOUT_ABORT_REASON ? "timeout" : "cancelled";
        }
        throw error;
      }
      const completedAt = Date.now();
      this.lastDiagnosticDurationMs = completedAt - touchedAt;
      this.lastDiagnosticOutcome = outcome;
      return {
        snapshot: this.snapshotForScope(document.uri, options.snapshotScope),
        fresh: outcome === "fresh",
        timedOut: outcome === "timeout",
        eventual: outcome === "eventual",
        requestedAt: touchedAt,
        completedAt,
      };
    });
  }

  async pullWorkspaceDiagnostics(options: WorkspaceDiagnosticPullOptions): Promise<WorkspaceDiagnosticPullResult> {
    return this.withActiveOperation(async () => {
      const deadlineAt = options.deadlineAt ?? Date.now() + Math.max(0, options.timeoutMs);
      const deadline = createDeadlineSignal(deadlineAt, options.signal);
      try {
        try {
          await this.ensureStarted(deadline.signal);
        } catch (error) {
          if (options.signal?.aborted) throw abortError(options.signal);
          if (deadline.timedOut) return workspaceDiagnosticPullResult(false, "timed-out");
          throw error;
        }
        throwIfAborted(deadline.signal);

        const provider = workspaceDiagnosticProvider(this.capabilities);
        if (!provider) return workspaceDiagnosticPullResult(false, "unavailable");
        if (options.uris.size === 0) return workspaceDiagnosticPullResult(false, "unavailable");
        if (remainingUntil(deadlineAt) <= 0) return workspaceDiagnosticPullResult(false, "timed-out");

        const requestedAt = Date.now();
        const stateGeneration = this.workspaceStateGeneration;
        const documentVersions = new Map<string, number | undefined>();
        const previousResultIds = new Map<string, string>();
        for (const uri of options.uris) {
          documentVersions.set(uri, this.documents.get(uri)?.version);
          const resultId = this.workspaceDiagnosticResultIds.get(uri);
          if (resultId !== undefined && this.diagnostics.get(uri)?.authoritative === true) {
            previousResultIds.set(uri, resultId);
          }
        }

        const partialResultToken = `${this.sessionId ?? this.id}:workspace-diagnostic:${this.nextProgressToken++}`;
        const collector: WorkspaceDiagnosticReportCollector = {
          reports: new Map(),
          reportEntries: 0,
          diagnosticEntries: 0,
          collectedBytes: 0,
          malformed: false,
        };
        this.progressHandlers.set(partialResultToken, (value) => {
          if (!appendWorkspaceDiagnosticReportChunk(collector, value)) collector.malformed = true;
        });

        const params: Record<string, unknown> = {
          previousResultIds: [...previousResultIds].map(([uri, value]) => ({ uri, value })),
          partialResultToken,
        };
        if (provider.identifier !== undefined) params.identifier = provider.identifier;

        let response: unknown;
        try {
          response = await this.sendRequest(
            "workspace/diagnostic",
            params,
            Math.max(1, remainingUntil(deadlineAt)),
            deadline.signal,
          );
        } catch (error) {
          if (options.signal?.aborted) throw abortError(options.signal);
          return workspaceDiagnosticPullResult(
            true,
            deadline.timedOut || isRequestTimeout(error, "workspace/diagnostic") ? "timed-out" : "unavailable",
          );
        } finally {
          this.progressHandlers.delete(partialResultToken);
        }

        if (!appendWorkspaceDiagnosticReportChunk(collector, response) || collector.malformed) {
          return workspaceDiagnosticPullResult(true, "unavailable");
        }
        if (this.workspaceStateGeneration !== stateGeneration) {
          return workspaceDiagnosticPullResult(true, "unavailable");
        }

        const receivedAt = Date.now();
        const coveredUris = new Set<string>();
        for (const [uri, report] of collector.reports) {
          if (!options.uris.has(uri)) continue;
          const expectedVersion = documentVersions.get(uri);
          const currentVersion = this.documents.get(uri)?.version;
          if (currentVersion !== expectedVersion) continue;
          if (expectedVersion === undefined ? report.version !== null : report.version !== expectedVersion) continue;

          if (report.kind === "unchanged") {
            if (!previousResultIds.has(uri) || this.diagnostics.get(uri)?.authoritative !== true || report.resultId === undefined) continue;
            this.workspaceDiagnosticResultIds.set(uri, report.resultId);
            coveredUris.add(uri);
            continue;
          }

          this.storeDiagnostics(uri, report.diagnostics ?? [], report.version ?? undefined, receivedAt, true);
          if (report.resultId === undefined) this.workspaceDiagnosticResultIds.delete(uri);
          else this.workspaceDiagnosticResultIds.set(uri, report.resultId);
          coveredUris.add(uri);
        }

        try {
          await settleDiagnostics(options.settleMs, deadline.signal);
        } catch (error) {
          if (options.signal?.aborted) throw abortError(options.signal);
          if (deadline.timedOut) return workspaceDiagnosticPullResult(true, "timed-out");
          throw error;
        }
        this.lastDiagnosticDurationMs = Date.now() - requestedAt;
        this.lastDiagnosticOutcome = "fresh";
        return workspaceDiagnosticPullResult(true, "fresh", coveredUris);
      } finally {
        deadline.dispose();
      }
    });
  }

  async refreshWorkspaceDocuments(
    documents: readonly WorkspaceDiagnosticDocument[],
    options: WorkspaceDocumentDiagnosticsOptions,
  ): Promise<WorkspaceDocumentDiagnosticsResult> {
    return this.withActiveOperation(async () => {
      const files = new Map<string, WorkspaceDocumentDiagnosticResult>();
      if (documents.length === 0) return { files };

      const deadline = createDeadlineSignal(options.deadlineAt, options.signal);
      const initiallyOpen = new Set(this.documents.keys());
      let usedPushBatch = false;
      try {
        try {
          await this.ensureStarted(deadline.signal);
        } catch (error) {
          if (options.signal?.aborted) throw abortError(options.signal);
          if (!deadline.timedOut) throw error;
          const protocol = hasAuthoritativeDocumentDiagnosticRequest(this.capabilities) ? "document-pull" : "push-batch";
          return {
            files: workspaceDocumentOutcomeMap(documents, protocol, "timed-out", "workspace diagnostic deadline expired during server initialization"),
          };
        }

        if (remainingUntil(options.deadlineAt) <= 0) {
          const protocol = hasAuthoritativeDocumentDiagnosticRequest(this.capabilities) ? "document-pull" : "push-batch";
          return {
            files: workspaceDocumentOutcomeMap(documents, protocol, "timed-out", "workspace diagnostic deadline expired before document refresh"),
          };
        }

        if (hasAuthoritativeDocumentDiagnosticRequest(this.capabilities)) {
          const pulled = await this.pullWorkspaceDocumentDiagnostics(documents, options, deadline);
          const pushFallbackDocuments = documents.filter((document) => (
            pulled.get(filePathToUri(document.filePath))?.fallbackToPush === true
          ));
          if (pushFallbackDocuments.length === 0 || remainingUntil(options.deadlineAt) <= 0) {
            return { files: pulled };
          }

          usedPushBatch = true;
          const pushed = await this.pushWorkspaceDocumentDiagnostics(pushFallbackDocuments, options, deadline);
          for (const [uri, result] of pushed) pulled.set(uri, result);
          return {
            files: pulled,
          };
        }

        usedPushBatch = true;
        return {
          files: await this.pushWorkspaceDocumentDiagnostics(documents, options, deadline),
        };
      } catch (error) {
        if (options.signal?.aborted) throw abortError(options.signal);
        if (!deadline.timedOut) throw error;
        return {
          files: workspaceDocumentOutcomeMap(
            documents,
            usedPushBatch ? "push-batch" : "document-pull",
            "timed-out",
            "workspace diagnostic deadline expired during document refresh",
          ),
        };
      } finally {
        for (const document of documents) {
          const uri = filePathToUri(document.filePath);
          if (initiallyOpen.has(uri)) continue;
          this.closeDocument(uri);
          this.invalidateDiagnostics(uri);
        }

        if (usedPushBatch && (deadline.timedOut || options.signal?.aborted)) {
          this.terminateAfterWorkspaceDiagnosticBatch(
            options.signal?.aborted
              ? "push diagnostic batch was cancelled"
              : "push diagnostic batch exceeded the workspace deadline",
          );
        }
        deadline.dispose();
      }
    });
  }

  private async pullWorkspaceDocumentDiagnostics(
    documents: readonly WorkspaceDiagnosticDocument[],
    options: WorkspaceDocumentDiagnosticsOptions,
    deadline: DeadlineSignal,
  ): Promise<Map<string, WorkspaceDocumentDiagnosticResult>> {
    const files = new Map<string, WorkspaceDocumentDiagnosticResult>();
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        const documentInput = documents[nextIndex++];
        if (!documentInput) return;
        const uri = filePathToUri(documentInput.filePath);
        if (deadline.timedOut || remainingUntil(options.deadlineAt) <= 0) {
          files.set(uri, {
            outcome: "timed-out",
            protocol: "document-pull",
            reason: "workspace diagnostic deadline expired before document pull",
          });
          continue;
        }

        const touchedAt = Date.now();
        try {
          const document = this.syncDocument(documentInput.filePath, documentInput.content);
          this.notify("textDocument/didSave", textDocumentDidSaveParams(document.uri, documentInput.content, this.capabilities));
          const outcome = await this.pullDiagnostics(document, document.version, touchedAt, {
            timeoutMs: Math.max(1, remainingUntil(options.deadlineAt)),
            settleMs: options.settleMs,
            forceFresh: true,
            signal: deadline.signal,
          });

          if (outcome === "authoritative") {
            files.set(uri, {
              outcome: "fresh",
              protocol: "document-pull",
              snapshot: this.snapshotForUri(uri),
            });
          } else {
            const timedOut = outcome === "timed-out" || deadline.timedOut;
            files.set(uri, {
              outcome: timedOut ? "timed-out" : "unavailable",
              protocol: "document-pull",
              reason: timedOut
                ? "workspace diagnostic deadline expired during document pull"
                : outcome === "malformed"
                  ? "document diagnostic pull returned a malformed response"
                  : "document diagnostic pull was unavailable",
              ...(outcome === "unavailable" ? { fallbackToPush: true } : {}),
            });
          }
        } catch (error) {
          if (options.signal?.aborted) throw abortError(options.signal);
          if (!deadline.timedOut) throw error;
          files.set(uri, {
            outcome: "timed-out",
            protocol: "document-pull",
            reason: "workspace diagnostic deadline expired during document pull",
          });
        }
      }
    };

    const concurrency = Math.min(documents.length, Math.max(1, Math.floor(options.concurrency)));
    await Promise.all(Array.from({ length: concurrency }, worker));
    return files;
  }

  private async pushWorkspaceDocumentDiagnostics(
    documents: readonly WorkspaceDiagnosticDocument[],
    options: WorkspaceDocumentDiagnosticsOptions,
    deadline: DeadlineSignal,
  ): Promise<Map<string, WorkspaceDocumentDiagnosticResult>> {
    const files = new Map<string, WorkspaceDocumentDiagnosticResult>();
    const synchronized: Array<{ uri: string; version: number; touchedAt: number; observationDeadlineAt: number }> = [];

    // Synchronize the whole target set in one event-loop turn. Push-only
    // servers commonly debounce these notifications into one diagnostic pass.
    for (const documentInput of documents) {
      throwIfAborted(deadline.signal);
      const uri = filePathToUri(documentInput.filePath);
      const touchedAt = Date.now();
      const previousDocument = this.documents.get(uri);
      const hadReusablePushState = previousDocument?.content === documentInput.content &&
        isReusablePushDiagnosticEntry(this.diagnostics.get(uri));
      const document = this.syncDocument(documentInput.filePath, documentInput.content, true);
      const observationMs = pushDiagnosticObservationBudget(hadReusablePushState, options.settleMs);
      synchronized.push({
        uri,
        version: document.version,
        touchedAt,
        observationDeadlineAt: Math.min(options.deadlineAt, touchedAt + observationMs),
      });
    }
    for (let index = 0; index < documents.length; index += 1) {
      const documentInput = documents[index];
      const document = synchronized[index];
      this.notify("textDocument/didSave", textDocumentDidSaveParams(document.uri, documentInput.content, this.capabilities));
    }

    await Promise.all(synchronized.map(async (document) => {
      if (deadline.timedOut || remainingUntil(options.deadlineAt) <= 0) {
        files.set(document.uri, {
          outcome: "timed-out",
          protocol: "push-batch",
          reason: "workspace diagnostic deadline expired before a diagnostic publication",
        });
        return;
      }

      try {
        const fresh = await this.waitForDiagnostics(
          document.uri,
          document.version,
          document.touchedAt,
          remainingUntil(document.observationDeadlineAt),
          0,
          deadline.signal,
        );
        if (fresh) {
          files.set(document.uri, {
            outcome: "fresh",
            protocol: "push-batch",
            snapshot: this.snapshotForUri(document.uri),
          });
        } else if (deadline.timedOut || remainingUntil(options.deadlineAt) <= 0) {
          files.set(document.uri, {
            outcome: "timed-out",
            protocol: "push-batch",
            reason: "push-only server did not publish diagnostics before the workspace deadline",
          });
        } else if (this.ensureProvisionalPushDiagnostics(document.uri, document.version)) {
          files.set(document.uri, {
            outcome: "eventual",
            protocol: "push-batch",
            snapshot: this.snapshotForUri(document.uri),
            reason: "push-only server emitted no replacement; showing its latest published state",
          });
        } else {
          files.set(document.uri, {
            outcome: "unavailable",
            protocol: "push-batch",
            reason: "push-only server emitted malformed diagnostics and no usable replacement",
          });
        }
      } catch (error) {
        if (options.signal?.aborted) throw abortError(options.signal);
        if (!deadline.timedOut) throw error;
        files.set(document.uri, {
          outcome: "timed-out",
          protocol: "push-batch",
          reason: "push-only server did not publish diagnostics before the workspace deadline",
        });
      }
    }));

    if ([...files.values()].every((result) => result.outcome === "fresh") && options.settleMs > 0) {
      try {
        await this.settleDiagnosticQuiescence(options.settleMs, options.deadlineAt, deadline.signal);
        for (const document of synchronized) {
          const result = files.get(document.uri);
          if (result?.outcome === "fresh") result.snapshot = this.snapshotForUri(document.uri);
        }
      } catch (error) {
        if (options.signal?.aborted) throw abortError(options.signal);
        if (!deadline.timedOut) throw error;
      }
    }

    const completedAt = Date.now();
    const requestedAt = Math.min(...synchronized.map((document) => document.touchedAt));
    this.lastDiagnosticDurationMs = Math.max(0, completedAt - requestedAt);
    const outcomes = [...files.values()].map((result) => result.outcome);
    if (outcomes.includes("timed-out")) this.lastDiagnosticOutcome = "timeout";
    else if (outcomes.includes("unavailable")) this.lastDiagnosticOutcome = "unavailable";
    else if (outcomes.includes("eventual")) this.lastDiagnosticOutcome = "eventual";
    else this.lastDiagnosticOutcome = "fresh";
    return files;
  }

  private async settleDiagnosticQuiescence(settleMs: number, deadlineAt: number, signal?: AbortSignal): Promise<void> {
    while (true) {
      throwIfAborted(signal);
      const quietFor = Date.now() - (this.lastDiagnosticsAt ?? Date.now());
      if (quietFor >= settleMs) return;
      const remaining = remainingUntil(deadlineAt);
      if (remaining <= 0) throw abortError(signal);
      await waitWithSignal(sleep(Math.min(settleMs - quietFor, remaining)), signal);
    }
  }

  async ensureDocument(filePath: string, content: string, signal?: AbortSignal): Promise<void> {
    await this.withActiveOperation(async () => {
      await this.ensureStarted(signal);
      throwIfAborted(signal);
      this.syncDocument(filePath, content);
    });
  }

  async start(signal?: AbortSignal): Promise<void> {
    await this.withActiveOperation(() => this.ensureStarted(signal));
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
    return this.diagnostics.get(uri)?.authoritative === true;
  }

  forgetDocument(filePath: string): void {
    const uri = filePathToUri(filePath);
    if (this.documents.has(uri) || this.diagnostics.has(uri)) this.noteActivity();
    this.closeDocument(uri);
    this.invalidateDiagnostics(uri);
  }

  invalidateDiagnosticsForFile(filePath: string): void {
    this.invalidateDiagnostics(filePathToUri(filePath));
  }

  openDocumentsForReconciliation(): OpenDocumentState[] {
    if (this.state !== "ready") return [];
    return [...this.documents.values()].map((document) => ({
      filePath: document.filePath,
      content: document.content,
    }));
  }

  reconcileOpenDocument(filePath: string, content: string): boolean {
    if (this.state !== "ready") return false;
    const uri = filePathToUri(filePath);
    const current = this.documents.get(uri);
    if (!current || current.content === content) return false;

    this.noteActivity();
    const document = this.syncDocument(filePath, content);
    this.notify("textDocument/didSave", textDocumentDidSaveParams(document.uri, content, this.capabilities));
    return true;
  }

  notifyFileMutations(mutations: readonly LspFileMutation[]): boolean {
    if (this.state !== "ready" || mutations.length === 0) return false;
    this.noteActivity();

    const watchedChanges: Array<{ uri: string; type: number }> = [];
    const renamedFiles: Array<{ oldUri: string; newUri: string }> = [];
    const watchedKeys = new Set<string>();
    const closedUris = new Set<string>();

    const addWatchedChange = (filePath: string, type: number) => {
      const uri = filePathToUri(filePath);
      const key = `${uri}\0${type}`;
      if (!watchedKeys.has(key)) {
        watchedKeys.add(key);
        watchedChanges.push({ uri, type });
      }
      if (type === FILE_CHANGE_DELETED || !this.documents.has(uri) || hasAuthoritativeDocumentDiagnosticRequest(this.capabilities)) {
        this.invalidateDiagnostics(uri);
      }
    };

    for (const mutation of mutations) {
      switch (mutation.type) {
        case "created":
          addWatchedChange(mutation.filePath, FILE_CHANGE_CREATED);
          break;
        case "changed":
          addWatchedChange(mutation.filePath, FILE_CHANGE_CHANGED);
          break;
        case "deleted": {
          const uri = filePathToUri(mutation.filePath);
          addWatchedChange(mutation.filePath, FILE_CHANGE_DELETED);
          closedUris.add(uri);
          break;
        }
        case "renamed": {
          const oldUri = filePathToUri(mutation.oldFilePath);
          const newUri = filePathToUri(mutation.newFilePath);
          addWatchedChange(mutation.oldFilePath, FILE_CHANGE_DELETED);
          addWatchedChange(mutation.newFilePath, FILE_CHANGE_CREATED);
          closedUris.add(oldUri);
          renamedFiles.push({ oldUri, newUri });
          break;
        }
      }
    }

    try {
      for (const uri of closedUris) this.closeDocument(uri);
      if (renamedFiles.length > 0) {
        this.notify("workspace/didRenameFiles", { files: renamedFiles });
      }
      if (watchedChanges.length > 0) {
        this.notify("workspace/didChangeWatchedFiles", { changes: watchedChanges });
      }
      return true;
    } catch (error) {
      this.lastError = errorMessage(error);
      return false;
    }
  }

  async request(method: string, params?: unknown, timeoutMs = 10_000, signal?: AbortSignal): Promise<unknown> {
    return this.withActiveOperation(async () => {
      await this.ensureStarted(signal);
      return this.sendRequest(method, params, timeoutMs, signal);
    });
  }

  async requestForDocument(filePath: string, content: string, method: string, params: Record<string, unknown>, timeoutMs = 10_000, signal?: AbortSignal): Promise<unknown> {
    return this.withActiveOperation(async () => {
      await this.ensureStarted(signal);
      throwIfAborted(signal);
      this.syncDocument(filePath, content);
      return this.sendRequest(method, params, timeoutMs, signal);
    });
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

  canRenameFiles(oldFilePath: string, newFilePath: string): boolean {
    return fileRenameProvider(this.capabilities, oldFilePath, newFilePath);
  }

  hasActiveWork(): boolean {
    return this.shuttingDown ||
      this.activeOperations > 0 ||
      this.state === "queued" ||
      this.state === "starting" ||
      this.initializationAttempt !== undefined ||
      this.pending.size > 0 ||
      this.outboundBytes > 0 ||
      this.diagnosticWaiters.size > 0;
  }

  getLastActivityAt(): number {
    return this.lastActivityAt;
  }

  getStatus(): LspClientStatus {
    return {
      id: this.id,
      role: this.definition.role,
      root: this.root,
      command: this.definition.command,
      args: this.definition.args,
      state: this.state,
      pid: this.process?.pid,
      busy: this.hasActiveWork(),
      lastActivityAt: this.lastActivityAt,
      startCount: this.startCount,
      restartCount: this.restartCount,
      initializationCooldownCount: this.initializationCooldownCount,
      openDocuments: this.documents.size,
      diagnosticFiles: this.diagnostics.size,
      lastDiagnosticsAt: this.lastDiagnosticsAt,
      lastDiagnosticDurationMs: this.lastDiagnosticDurationMs,
      lastDiagnosticOutcome: this.lastDiagnosticOutcome,
      lastError: this.lastError,
      initializationRetryAt: this.activeInitializationFailure()?.retryAt,
      lastServerLog: this.lastServerLog,
      environment: this.definition.environment?.description,
    };
  }

  async shutdown(signal?: AbortSignal): Promise<void> {
    if (this.shutdownPromise) return waitWithSignal(this.shutdownPromise, signal);
    const shutdown = this.performShutdown(signal);
    this.shutdownPromise = shutdown;
    try {
      await shutdown;
    } finally {
      if (this.shutdownPromise === shutdown) this.shutdownPromise = undefined;
    }
  }

  private terminateAfterWorkspaceDiagnosticBatch(reason: string): void {
    const child = this.process;
    if (!child) return;
    const error = new Error(`${this.id} ${reason}; stopped to drain non-cancellable server work`);
    this.lastError = error.message;
    this.state = "stopped";
    this.sessionId = undefined;
    this.detachActiveProcess(child);
    this.clearServerState();
    this.rejectPending(error);
    this.finishDiagnosticWaiters(false);
    terminateProcess(child);
    this.signalResourceChange();
  }

  private async performShutdown(signal?: AbortSignal): Promise<void> {
    this.shuttingDown = true;
    this.initializationAttempt?.controller.abort("LSP client stopped");
    this.signalResourceChange();
    this.finishDiagnosticWaiters(false);
    const child = this.process;
    const generation = this.launchGeneration;
    try {
      if (!child) {
        this.resetStoppedState();
        return;
      }

      if (this.state === "ready") {
        try {
          await this.sendRequest("shutdown", undefined, 1500, signal);
          if (this.isActiveLaunch(child, generation)) await this.notifyAndWait("exit");
        } catch {
          // Fall through to killing the process.
        }
      }

      if (this.isActiveLaunch(child, generation)) this.detachActiveProcess(child);
      this.rejectPending(new Error("LSP client stopped"));
      this.resetStoppedState();
      await terminateProcessAndWait(child);
    } finally {
      this.shuttingDown = false;
      this.signalResourceChange();
    }
  }

  private async ensureStarted(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.state === "ready") return;
    if (this.initializationAttempt) return this.waitForInitialization(this.initializationAttempt, signal);

    const cachedFailure = this.activeInitializationFailure();
    if (cachedFailure) {
      throw new Error(
        `LSP initialization is cooling down for ${this.id} until ${new Date(cachedFailure.retryAt).toISOString()}: ${cachedFailure.message}`,
      );
    }

    const controller = new AbortController();
    this.state = "queued";
    this.signalResourceChange();
    const promise = this.startAndInitialize(controller.signal);
    const attempt: InitializationAttempt = { controller, promise, waiters: 0 };
    this.initializationAttempt = attempt;
    promise.then(
      () => {
        if (this.initializationAttempt === attempt) {
          this.initializationAttempt = undefined;
          this.signalResourceChange();
        }
      },
      () => {
        if (this.initializationAttempt === attempt) {
          this.initializationAttempt = undefined;
          if (this.state === "queued") this.state = "stopped";
          this.signalResourceChange();
        }
      },
    );
    return this.waitForInitialization(attempt, signal);
  }

  private async waitForInitialization(attempt: InitializationAttempt, signal?: AbortSignal): Promise<void> {
    attempt.waiters += 1;
    try {
      await waitWithSignal(attempt.promise, signal);
    } finally {
      attempt.waiters = Math.max(0, attempt.waiters - 1);
      if (this.initializationAttempt === attempt && attempt.waiters === 0) {
        attempt.controller.abort("LSP initialization has no active waiters");
      }
    }
  }

  private async startAndInitialize(signal?: AbortSignal): Promise<void> {
    let releaseStartPermit: (() => void) | undefined;
    try {
      releaseStartPermit = this.acquireStartPermit
        ? await this.acquireStartPermit(signal)
        : () => undefined;
      throwIfAborted(signal);
      this.state = "starting";
      this.signalResourceChange();
      await this.launchAndInitialize(signal);
    } finally {
      releaseStartPermit?.();
    }
  }

  private async launchAndInitialize(signal?: AbortSignal): Promise<void> {
    const generation = ++this.launchGeneration;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.definition.command, this.definition.args, {
        cwd: this.root,
        env: mergeProcessEnv(this.definition.env),
        stdio: "pipe",
      });
    } catch (error) {
      const failure = asError(error);
      this.state = "failed";
      this.sessionId = undefined;
      this.lastError = failure.message;
      this.clearServerState();
      this.finishDiagnosticWaiters(false);
      this.cacheInitializationFailure(failure, signal);
      throw failure;
    }
    this.process = child;
    const restarting = this.startCount > 0;
    this.startCount += 1;
    this.onLifecycleEvent?.("start");
    if (restarting) {
      this.restartCount += 1;
      this.onLifecycleEvent?.("restart");
    }
    this.signalResourceChange();
    this.inputBuffer = Buffer.alloc(0);

    child.stdout.on("data", (chunk: Buffer) => {
      if (this.isActiveLaunch(child, generation)) this.handleData(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!this.isActiveLaunch(child, generation)) return;
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) this.lastServerLog = classifyServerLog(text.slice(-1000));
    });
    child.stdin.on("error", (error) => {
      if (!this.isActiveLaunch(child, generation)) return;
      this.failActiveLaunch(child, error);
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
      this.signalResourceChange();
    });

    try {
      const initializeResult = await this.sendRequest("initialize", this.initializeParams(), this.initializeTimeoutMs, signal);
      if (!this.isActiveLaunch(child, generation)) throw new Error(`LSP initialization was superseded: ${this.id}`);
      this.capabilities = isRecord(initializeResult) ? initializeResult.capabilities : undefined;
      await this.notifyAndWait("initialized", {});
      if (!this.isActiveLaunch(child, generation)) throw new Error(`LSP initialization was superseded: ${this.id}`);
      this.state = "ready";
      this.sessionId = createLspClientSessionId(this.id);
      this.lastError = undefined;
      this.initializationFailure = undefined;
      this.signalResourceChange();
    } catch (error) {
      if (this.isActiveLaunch(child, generation)) {
        this.failActiveLaunch(child, error);
      }
      this.cacheInitializationFailure(error, signal);
      throw error;
    }
  }

  private isActiveLaunch(child: ChildProcessWithoutNullStreams, generation: number): boolean {
    return this.process === child && this.launchGeneration === generation;
  }

  private failActiveLaunch(child: ChildProcessWithoutNullStreams, error: unknown): void {
    const failure = asError(error);
    this.lastError = failure.message;
    this.state = "failed";
    this.sessionId = undefined;
    this.detachActiveProcess(child);
    this.clearServerState();
    this.rejectPending(failure);
    this.finishDiagnosticWaiters(false);
    terminateProcess(child);
    this.signalResourceChange();
  }

  private detachActiveProcess(child: ChildProcessWithoutNullStreams): void {
    if (this.process !== child) return;
    this.discardOutboundForProcess(child, new Error(`LSP process stopped: ${this.id}`));
    this.process = undefined;
    this.inputBuffer = Buffer.alloc(0);
  }

  private resetStoppedState(): void {
    this.state = "stopped";
    this.sessionId = undefined;
    this.initializationAttempt = undefined;
    this.initializationFailure = undefined;
    this.clearServerState();
    this.signalResourceChange();
  }

  private activeInitializationFailure(): InitializationFailure | undefined {
    const failure = this.initializationFailure;
    if (!failure) return undefined;
    if (failure.retryAt > Date.now()) return failure;
    this.initializationFailure = undefined;
    return undefined;
  }

  private cacheInitializationFailure(error: unknown, signal?: AbortSignal): void {
    if (this.initializationFailureCooldownMs <= 0 || isTransientInitializationFailure(error, signal)) return;
    const message = errorMessage(error);
    this.state = "failed";
    this.lastError = message;
    this.initializationFailure = {
      message,
      retryAt: Date.now() + this.initializationFailureCooldownMs,
    };
    this.initializationCooldownCount += 1;
    this.onLifecycleEvent?.("cooldown");
    this.signalResourceChange();
  }

  private clearServerState(): void {
    this.capabilities = undefined;
    this.documents.clear();
    this.diagnostics.clear();
    this.suppressedClosedDocumentDiagnostics.clear();
    this.workspaceDiagnosticResultIds.clear();
    this.progressHandlers.clear();
    this.workspaceStateGeneration += 1;
  }

  private initializeParams(): Record<string, unknown> {
    const rootUri = filePathToUri(this.root);
    return {
      processId: typeof process.pid === "number" ? process.pid : null,
      clientInfo: { name: "code-feedback" },
      rootPath: this.root,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) || this.root }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
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
          diagnostics: { refreshSupport: true },
          fileOperations: {
            dynamicRegistration: false,
            willCreate: false,
            didCreate: false,
            willRename: true,
            didRename: true,
            willDelete: false,
            didDelete: false,
          },
        },
        window: { workDoneProgress: false },
      },
      initializationOptions: this.definition.initializationOptions ?? {},
    };
  }

  private syncDocument(filePath: string, content: string, forceChange = false): OpenDocument {
    const uri = filePathToUri(filePath);
    this.suppressedClosedDocumentDiagnostics.delete(uri);
    const languageId = this.definition.languageId(filePath);
    const document = this.documents.get(uri);

    if (!document) {
      const opened: OpenDocument = { uri, filePath, languageId, version: 1, content };
      this.documents.set(uri, opened);
      this.workspaceDiagnosticResultIds.delete(uri);
      this.workspaceStateGeneration += 1;
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
    if (document.content === content && !forceChange) return document;

    const oldContent = document.content;
    document.version += 1;
    document.content = content;
    this.workspaceDiagnosticResultIds.delete(uri);
    this.workspaceStateGeneration += 1;

    const syncKind = textDocumentChangeSyncKind(this.capabilities);
    if (syncKind !== TEXT_DOCUMENT_SYNC_NONE) {
      const contentChanges = forceChange || syncKind !== TEXT_DOCUMENT_SYNC_INCREMENTAL
        ? [{ text: content }]
        : [incrementalContentChange(oldContent, content)];
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: document.version },
        contentChanges,
      });
    }

    return document;
  }

  private closeDocument(uri: string): void {
    const wasOpen = this.documents.has(uri);
    if (wasOpen && this.state === "ready") {
      try {
        this.notify("textDocument/didClose", { textDocument: { uri } });
      } catch (error) {
        this.lastError = errorMessage(error);
      }
    }
    this.documents.delete(uri);
    if (wasOpen) {
      this.suppressedClosedDocumentDiagnostics.set(uri, Date.now() + CLOSED_DOCUMENT_DIAGNOSTIC_SUPPRESSION_MS);
      this.workspaceDiagnosticResultIds.delete(uri);
      this.workspaceStateGeneration += 1;
    }
  }

  private invalidateDiagnostics(uri: string): void {
    this.diagnostics.delete(uri);
    this.workspaceDiagnosticResultIds.delete(uri);
    this.workspaceStateGeneration += 1;
    const waiters = this.diagnosticWaiters.get(uri);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter.finish(false);
  }

  private sendRequest(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    const id = this.nextRequestId++;
    const message: JsonRpcRequest = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      let pending: PendingRequest;
      const timeout = setTimeout(() => {
        if (!this.removePending(id, pending)) return;
        if (!this.discardQueuedOutbound(pending.outbound, new Error(`LSP request expired before it was written: ${method}`))) {
          this.cancelRequest(id);
        }
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);
      timeout.unref();
      const onAbort = signal ? () => {
        if (!this.removePending(id, pending)) return;
        if (!this.discardQueuedOutbound(pending.outbound, abortError(signal))) this.cancelRequest(id);
        reject(abortError(signal));
      } : undefined;
      pending = { method, resolve, reject, timeout, signal, onAbort };
      this.pending.set(id, pending);
      if (onAbort) signal!.addEventListener("abort", onAbort, { once: true });
      try {
        pending.outbound = this.send(message, method);
      } catch (error) {
        this.removePending(id, pending);
        reject(asError(error));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    const message: JsonRpcNotification = params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    this.send(message, method);
  }

  private async notifyAndWait(method: string, params?: unknown): Promise<void> {
    const message: JsonRpcNotification = params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    await this.waitForOutbound(this.send(message, method));
  }

  private cancelRequest(id: number | string): void {
    try {
      this.notify("$/cancelRequest", { id });
    } catch (error) {
      this.lastError = errorMessage(error);
    }
  }

  private send(message: JsonRpcMessage, label = "JSON-RPC message"): OutboundMessage {
    const child = this.process;
    if (!child?.stdin.writable) throw new Error(`LSP process is not writable: ${this.id}`);
    const body = JSON.stringify(message);
    const payload = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
    const byteLength = Buffer.byteLength(payload, "utf8");
    if (byteLength > this.maxQueuedWriteBytes || this.outboundBytes + byteLength > this.maxQueuedWriteBytes) {
      throw new Error(
        `LSP outbound queue limit exceeded for ${this.id}: ${this.outboundBytes + byteLength} bytes > ${this.maxQueuedWriteBytes}`,
      );
    }

    const outbound: OutboundMessage = {
      child,
      generation: this.launchGeneration,
      payload,
      byteLength,
      label,
      state: "queued",
    };
    this.outboundQueue.push(outbound);
    this.outboundBytes += byteLength;
    this.signalOutboundResourceChange();
    this.pumpOutbound();
    return outbound;
  }

  private pumpOutbound(): void {
    if (this.activeOutbound) return;

    const outbound = this.outboundQueue.shift();
    if (!outbound) return;
    if (!this.isActiveLaunch(outbound.child, outbound.generation) || !outbound.child.stdin.writable) {
      const error = new Error(`LSP process is not writable: ${this.id}`);
      this.finishOutbound(outbound, error);
      this.pumpOutbound();
      return;
    }

    this.activeOutbound = outbound;
    outbound.state = "writing";
    outbound.timeout = setTimeout(() => {
      if (this.activeOutbound !== outbound || outbound.state !== "writing") return;
      const error = new Error(`LSP write timed out after ${this.writeTimeoutMs}ms: ${outbound.label}`);
      this.finishOutbound(outbound, error);
      if (this.isActiveLaunch(outbound.child, outbound.generation)) this.failActiveLaunch(outbound.child, error);
    }, this.writeTimeoutMs);
    outbound.timeout.unref();

    try {
      outbound.child.stdin.write(outbound.payload, "utf8", (error) => {
        if (outbound.state !== "writing") return;
        if (error) {
          const failure = asError(error);
          this.finishOutbound(outbound, failure);
          if (this.isActiveLaunch(outbound.child, outbound.generation)) this.failActiveLaunch(outbound.child, failure);
          return;
        }
        this.finishOutbound(outbound);
        this.pumpOutbound();
      });
    } catch (error) {
      const failure = asError(error);
      this.finishOutbound(outbound, failure);
      if (this.isActiveLaunch(outbound.child, outbound.generation)) this.failActiveLaunch(outbound.child, failure);
    }
  }

  private waitForOutbound(outbound: OutboundMessage): Promise<void> {
    if (outbound.state === "sent") return Promise.resolve();
    if (outbound.state === "discarded") return Promise.reject(outbound.error ?? new Error(`LSP message was not written: ${outbound.label}`));

    return new Promise((resolve, reject) => {
      const waiters = outbound.waiters ?? new Set<OutboundMessageWaiter>();
      waiters.add({ resolve, reject });
      outbound.waiters = waiters;
    });
  }

  private discardQueuedOutbound(outbound: OutboundMessage | undefined, error: Error): boolean {
    if (!outbound || outbound.state !== "queued") return false;
    const index = this.outboundQueue.indexOf(outbound);
    if (index < 0) return false;
    this.outboundQueue.splice(index, 1);
    this.finishOutbound(outbound, error);
    return true;
  }

  private finishOutbound(outbound: OutboundMessage, error?: Error): void {
    if (outbound.state === "sent" || outbound.state === "discarded") return;
    if (outbound.timeout) clearTimeout(outbound.timeout);
    outbound.timeout = undefined;
    if (this.activeOutbound === outbound) this.activeOutbound = undefined;
    this.outboundBytes = Math.max(0, this.outboundBytes - outbound.byteLength);
    outbound.state = error ? "discarded" : "sent";
    outbound.error = error;
    this.signalOutboundResourceChange();
    const waiters = outbound.waiters;
    outbound.waiters = undefined;
    if (!waiters) return;
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  private discardOutboundForProcess(child: ChildProcessWithoutNullStreams, error: Error): void {
    const active = this.activeOutbound;
    if (active?.child === child) this.finishOutbound(active, error);
    for (const outbound of [...this.outboundQueue]) {
      if (outbound.child !== child) continue;
      const index = this.outboundQueue.indexOf(outbound);
      if (index >= 0) this.outboundQueue.splice(index, 1);
      this.finishOutbound(outbound, error);
    }
  }

  private handleData(chunk: Buffer): void {
    this.inputBuffer = Buffer.concat([this.inputBuffer, chunk]);

    while (true) {
      const headerEnd = this.inputBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (this.inputBuffer.length > MAX_INBOUND_HEADER_BYTES) {
          this.failProtocol(new Error(`LSP header exceeds ${MAX_INBOUND_HEADER_BYTES} bytes: ${this.id}`));
        }
        return;
      }
      if (headerEnd > MAX_INBOUND_HEADER_BYTES) {
        this.failProtocol(new Error(`LSP header exceeds ${MAX_INBOUND_HEADER_BYTES} bytes: ${this.id}`));
        return;
      }

      const header = this.inputBuffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i);
      if (!lengthMatch) {
        this.inputBuffer = this.inputBuffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = Number.parseInt(lengthMatch[1], 10);
      if (!Number.isSafeInteger(contentLength) || contentLength > MAX_INBOUND_MESSAGE_BYTES) {
        this.failProtocol(new Error(`LSP message exceeds ${MAX_INBOUND_MESSAGE_BYTES} bytes: ${this.id}`));
        return;
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.inputBuffer.length < bodyEnd) return;

      const body = this.inputBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.inputBuffer = this.inputBuffer.subarray(bodyEnd);

      let message: unknown;
      try {
        message = JSON.parse(body);
        if (!isRecord(message)) {
          throw new Error(`LSP message must be a JSON object: ${this.id}`);
        }
        this.handleMessage(message as unknown as JsonRpcMessage);
      } catch (error) {
        this.failProtocol(asError(error));
        return;
      }
    }
  }

  private failProtocol(error: Error): void {
    const child = this.process;
    if (child) this.failActiveLaunch(child, error);
    else this.lastError = error.message;
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
      } else if (message.method === "$/progress") {
        this.handleProgress(message.params);
      }
    }
  }

  private handleProgress(params: unknown): void {
    if (!isRecord(params)) return;
    const token = params.token;
    if (typeof token !== "string" && typeof token !== "number") return;
    this.progressHandlers.get(token)?.(params.value);
  }

  private handleServerRequest(message: JsonRpcRequest): void {
    try {
      let result: unknown;
      switch (message.method) {
        case "workspace/configuration":
          result = this.workspaceConfiguration(message.params);
          break;
        case "workspace/workspaceFolders":
          result = [{ uri: filePathToUri(this.root), name: path.basename(this.root) || this.root }];
          break;
        case "workspace/applyEdit":
          result = { applied: false, failureReason: "code-feedback does not let language servers apply edits directly" };
          break;
        case "window/showDocument":
          result = { success: false };
          break;
        case "client/registerCapability":
        case "client/unregisterCapability":
        case "window/showMessageRequest":
        case "window/workDoneProgress/create":
          result = null;
          break;
        case "workspace/diagnostic/refresh":
          this.diagnostics.clear();
          this.workspaceDiagnosticResultIds.clear();
          this.workspaceStateGeneration += 1;
          result = null;
          break;
        case "workspace/codeLens/refresh":
        case "workspace/inlayHint/refresh":
        case "workspace/inlineValue/refresh":
        case "workspace/semanticTokens/refresh":
          result = null;
          break;
        default:
          this.send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `Method not found: ${message.method}` },
          }, `response:${message.method}`);
          return;
      }

      this.send({ jsonrpc: "2.0", id: message.id, result }, `response:${message.method}`);
    } catch (error) {
      this.lastError = errorMessage(error);
    }
  }

  private workspaceConfiguration(params: unknown): unknown[] {
    const items = isRecord(params) && Array.isArray(params.items) ? params.items : [];
    const config = this.definition.workspaceConfiguration;
    return items.map((item) => configurationForItem(config, item));
  }

  private async pullDiagnostics(
    document: OpenDocument,
    documentVersion: number,
    touchedAt: number,
    options: TouchDocumentOptions,
  ): Promise<PullDiagnosticOutcome> {
    const provider = documentDiagnosticProvider(this.capabilities);
    if (!provider) {
      return typescriptTsserverDiagnosticProvider(this.capabilities)
        ? this.pullTypescriptTsserverDiagnostics(document, documentVersion, touchedAt, options)
        : "unavailable";
    }

    const timeoutMs = remainingDiagnosticTimeout(options.timeoutMs, touchedAt);
    if (timeoutMs <= 0) return "timed-out";

    const params: Record<string, unknown> = { textDocument: { uri: document.uri } };
    if (provider.identifier !== undefined) params.identifier = provider.identifier;

    let response: unknown;
    try {
      response = await this.sendRequest("textDocument/diagnostic", params, timeoutMs, options.signal);
    } catch (error) {
      if (isCancellation(error, options.signal)) throw error;
      return isRequestTimeout(error, "textDocument/diagnostic") ? "timed-out" : "unavailable";
    }

    const report = parseDocumentDiagnosticReport(response);
    if (!report) return "malformed";
    if (this.documents.get(document.uri)?.version !== documentVersion) return "unavailable";

    const receivedAt = Date.now();
    const authoritative = !report.malformed;
    this.workspaceDiagnosticResultIds.delete(document.uri);
    this.storeDiagnostics(document.uri, report.diagnostics, documentVersion, receivedAt, authoritative);
    for (const related of report.relatedDocuments) {
      if (related.uri === document.uri) continue;
      this.workspaceDiagnosticResultIds.delete(related.uri);
      this.storeDiagnostics(related.uri, related.diagnostics, undefined, receivedAt, authoritative);
    }
    if (!authoritative) return "malformed";
    await settleDiagnostics(options.settleMs, options.signal);
    return "authoritative";
  }

  private async pullTypescriptTsserverDiagnostics(
    document: OpenDocument,
    documentVersion: number,
    touchedAt: number,
    options: TouchDocumentOptions,
  ): Promise<PullDiagnosticOutcome> {
    const diagnostics: RawLspDiagnostic[] = [];
    for (const command of TYPESCRIPT_DIAGNOSTIC_COMMANDS) {
      const timeoutMs = remainingDiagnosticTimeout(options.timeoutMs, touchedAt);
      if (timeoutMs <= 0) return "timed-out";

      let response: unknown;
      try {
        response = await this.sendRequest("workspace/executeCommand", {
          command: TYPESCRIPT_TSSERVER_REQUEST_COMMAND,
          arguments: [command, { file: document.filePath }, {}],
        }, timeoutMs, options.signal);
      } catch (error) {
        if (isCancellation(error, options.signal)) throw error;
        return isRequestTimeout(error, "workspace/executeCommand") ? "timed-out" : "unavailable";
      }

      const parsed = parseTsServerDiagnosticResponse(response, command);
      if (!parsed || diagnostics.length + parsed.diagnostics.length > MAX_WORKSPACE_DIAGNOSTIC_ENTRIES) {
        return "malformed";
      }
      diagnostics.push(...parsed.diagnostics);
    }

    if (this.documents.get(document.uri)?.version !== documentVersion) return "unavailable";
    const receivedAt = Date.now();
    this.workspaceDiagnosticResultIds.delete(document.uri);
    this.storeDiagnostics(document.uri, diagnostics, documentVersion, receivedAt, true);
    await settleDiagnostics(options.settleMs, options.signal);
    return "authoritative";
  }

  private handlePublishDiagnostics(params: unknown): void {
    if (!isRecord(params)) return;
    const diagnostics = params as PublishDiagnosticsParams;
    if (typeof diagnostics.uri !== "string" || diagnostics.uri.length === 0) return;
    const suppressedUntil = this.suppressedClosedDocumentDiagnostics.get(diagnostics.uri);
    if (suppressedUntil !== undefined && !this.documents.has(diagnostics.uri)) {
      if (Date.now() < suppressedUntil) return;
      this.suppressedClosedDocumentDiagnostics.delete(diagnostics.uri);
    }
    const validVersion = diagnostics.version === undefined || isLspInteger(diagnostics.version);
    const parsed = parseDiagnosticItems(diagnostics.diagnostics);

    this.workspaceDiagnosticResultIds.delete(diagnostics.uri);
    this.storeDiagnostics(
      diagnostics.uri,
      parsed?.diagnostics ?? [],
      validVersion ? diagnostics.version : undefined,
      Date.now(),
      validVersion && parsed !== undefined && !parsed.malformed,
    );
  }

  private storeDiagnostics(
    uri: string,
    diagnostics: RawLspDiagnostic[],
    version: number | undefined,
    receivedAt: number,
    authoritative: boolean,
  ): void {
    const entry: DiagnosticEntry = { uri, version, diagnostics, receivedAt, authoritative };
    this.diagnostics.set(uri, entry);
    this.lastDiagnosticsAt = entry.receivedAt;
    this.notifyDiagnosticWaiters(entry);
  }

  private ensureProvisionalPushDiagnostics(uri: string, version: number): boolean {
    const current = this.diagnostics.get(uri);
    if (current) return isReusablePushDiagnosticEntry(current);
    this.diagnostics.set(uri, {
      uri,
      version,
      diagnostics: [],
      receivedAt: Date.now(),
      authoritative: false,
      provisional: true,
    });
    return true;
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
      timeout.unref();
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
    this.signalOutboundResourceChange();
    return true;
  }

  private async withActiveOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.activeOperations += 1;
    this.noteActivity();
    try {
      return await operation();
    } finally {
      this.activeOperations = Math.max(0, this.activeOperations - 1);
      this.noteActivity();
    }
  }

  private noteActivity(): void {
    this.lastActivityAt = Date.now();
    this.signalResourceChange();
  }

  private signalResourceChange(): void {
    this.onResourceChange?.();
  }

  private signalOutboundResourceChange(): void {
    if (this.activeOperations === 0 && !this.shuttingDown) this.signalResourceChange();
  }
}

function diagnosticsAreFresh(entry: DiagnosticEntry, minVersion: number, touchedAt: number): boolean {
  if (!entry.authoritative) return false;
  if (typeof entry.version === "number") return entry.version >= minVersion;
  return entry.receivedAt >= touchedAt;
}

function isReusablePushDiagnosticEntry(entry: DiagnosticEntry | undefined): boolean {
  return entry?.authoritative === true || entry?.provisional === true;
}

function pushDiagnosticObservationBudget(reusableState: boolean, settleMs: number): number {
  return reusableState
    ? Math.max(PUSH_DIAGNOSTIC_REUSE_OBSERVATION_MS, settleMs)
    : PUSH_DIAGNOSTIC_INITIAL_OBSERVATION_MS;
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

function codeActionResolveProvider(capabilities: unknown): boolean {
  const provider = isRecord(capabilities) ? capabilities.codeActionProvider : undefined;
  return isRecord(provider) && provider.resolveProvider === true;
}

function fileRenameProvider(capabilities: unknown, oldFilePath: string, newFilePath: string): boolean {
  const workspace = isRecord(capabilities) ? capabilities.workspace : undefined;
  const fileOperations = isRecord(workspace) ? workspace.fileOperations : undefined;
  const provider = isRecord(fileOperations) ? fileOperations.willRename : undefined;
  if (!isRecord(provider) || !Array.isArray(provider.filters)) return false;
  return provider.filters.some((filter) => (
    fileOperationFilterMatches(filter, oldFilePath) || fileOperationFilterMatches(filter, newFilePath)
  ));
}

function fileOperationFilterMatches(value: unknown, filePath: string): boolean {
  if (!isRecord(value)) return false;
  if (value.scheme !== undefined && value.scheme !== "file") return false;
  const pattern = value.pattern;
  if (!isRecord(pattern) || typeof pattern.glob !== "string") return false;
  if (pattern.matches !== undefined && pattern.matches !== "file") return false;

  const ignoreCase = isRecord(pattern.options) && pattern.options.ignoreCase === true;
  const candidate = filePath.replaceAll(path.sep, "/");
  const glob = pattern.glob.replaceAll("\\", "/");
  const comparableCandidate = ignoreCase ? candidate.toLowerCase() : candidate;
  const comparableGlob = ignoreCase ? glob.toLowerCase() : glob;
  try {
    return path.matchesGlob(comparableCandidate, comparableGlob) ||
      path.matchesGlob(path.basename(comparableCandidate), comparableGlob);
  } catch {
    return false;
  }
}

function documentDiagnosticProvider(capabilities: unknown): DocumentDiagnosticProvider | undefined {
  const provider = isRecord(capabilities) ? capabilities.diagnosticProvider : undefined;
  if (provider === true) return {};
  if (!isRecord(provider)) return undefined;
  return typeof provider.identifier === "string" ? { identifier: provider.identifier } : {};
}

function hasAuthoritativeDocumentDiagnosticRequest(capabilities: unknown): boolean {
  return documentDiagnosticProvider(capabilities) !== undefined || typescriptTsserverDiagnosticProvider(capabilities);
}

function typescriptTsserverDiagnosticProvider(capabilities: unknown): boolean {
  const provider = isRecord(capabilities) ? capabilities.executeCommandProvider : undefined;
  return isRecord(provider) &&
    Array.isArray(provider.commands) &&
    provider.commands.includes(TYPESCRIPT_TSSERVER_REQUEST_COMMAND);
}

function workspaceDiagnosticProvider(capabilities: unknown): WorkspaceDiagnosticProvider | undefined {
  const provider = isRecord(capabilities) ? capabilities.diagnosticProvider : undefined;
  if (!isRecord(provider) || provider.workspaceDiagnostics !== true) return undefined;
  return {
    workspaceDiagnostics: true,
    ...(typeof provider.identifier === "string" ? { identifier: provider.identifier } : {}),
  };
}

function workspaceDiagnosticPullResult(
  attempted: boolean,
  outcome: WorkspaceDiagnosticPullOutcome,
  coveredUris: ReadonlySet<string> = new Set(),
): WorkspaceDiagnosticPullResult {
  return { attempted, outcome, coveredUris };
}

function appendWorkspaceDiagnosticReportChunk(
  collector: WorkspaceDiagnosticReportCollector,
  value: unknown,
): boolean {
  if (!isRecord(value) || !Array.isArray(value.items)) return false;
  if (collector.reportEntries + value.items.length > MAX_WORKSPACE_DIAGNOSTIC_REPORT_ENTRIES) return false;
  collector.reportEntries += value.items.length;

  for (const item of value.items) {
    const report = parseWorkspaceDocumentDiagnosticReport(item);
    if (!report || collector.reports.has(report.uri)) return false;
    const diagnosticEntries = report.diagnostics?.length ?? 0;
    const collectedBytes = workspaceDiagnosticReportBytes(report);
    if (collector.diagnosticEntries + diagnosticEntries > MAX_WORKSPACE_DIAGNOSTIC_ENTRIES) return false;
    if (collector.collectedBytes + collectedBytes > MAX_WORKSPACE_DIAGNOSTIC_COLLECTED_BYTES) return false;
    collector.diagnosticEntries += diagnosticEntries;
    collector.collectedBytes += collectedBytes;
    collector.reports.set(report.uri, report);
  }
  return true;
}

function parseWorkspaceDocumentDiagnosticReport(value: unknown): ParsedWorkspaceDocumentDiagnosticReport | undefined {
  if (!isRecord(value) || typeof value.uri !== "string" || value.uri.length === 0) return undefined;
  if (value.version !== null && !isLspInteger(value.version)) return undefined;

  if (value.kind === "unchanged") {
    if (typeof value.resultId !== "string") return undefined;
    return {
      uri: value.uri,
      version: value.version,
      kind: "unchanged",
      resultId: value.resultId,
    };
  }

  if (value.kind !== "full") return undefined;
  if (value.resultId !== undefined && typeof value.resultId !== "string") return undefined;
  const parsed = parseDiagnosticItems(value.items);
  if (!parsed || parsed.malformed) return undefined;
  return {
    uri: value.uri,
    version: value.version,
    kind: "full",
    resultId: value.resultId,
    diagnostics: parsed.diagnostics,
  };
}

function parseDocumentDiagnosticReport(value: unknown): ParsedDocumentDiagnosticReport | undefined {
  if (!isRecord(value) || value.kind !== "full") return undefined;
  if (value.resultId !== undefined && typeof value.resultId !== "string") return undefined;
  const parsed = parseDiagnosticItems(value.items);
  if (!parsed) return undefined;

  const relatedDocuments: ParsedDocumentDiagnosticReport["relatedDocuments"] = [];
  let malformed = parsed.malformed;
  if (value.relatedDocuments !== undefined) {
    if (!isRecord(value.relatedDocuments)) return undefined;
    for (const [uri, related] of Object.entries(value.relatedDocuments)) {
      if (uri.length === 0 || !isRecord(related)) return undefined;
      if (related.kind === "unchanged") {
        if (typeof related.resultId !== "string") return undefined;
        continue;
      }
      if (related.kind !== "full") return undefined;
      if (related.resultId !== undefined && typeof related.resultId !== "string") return undefined;
      const relatedItems = parseDiagnosticItems(related.items);
      if (!relatedItems) return undefined;
      malformed ||= relatedItems.malformed;
      relatedDocuments.push({ uri, diagnostics: relatedItems.diagnostics });
    }
  }

  return {
    diagnostics: parsed.diagnostics,
    relatedDocuments,
    malformed,
  };
}

function parseDiagnosticItems(value: unknown): ParsedDiagnosticItems | undefined {
  if (!Array.isArray(value)) return undefined;
  const diagnostics: RawLspDiagnostic[] = [];
  let malformed = false;
  for (const diagnostic of value) {
    if (isRawLspDiagnostic(diagnostic)) diagnostics.push(copyRawLspDiagnostic(diagnostic));
    else malformed = true;
  }
  return { diagnostics, malformed };
}

function parseTsServerDiagnosticResponse(value: unknown, command: string): TsServerDiagnosticResponse | undefined {
  if (
    !isRecord(value) ||
    value.type !== "response" ||
    value.success !== true ||
    value.command !== command ||
    !Array.isArray(value.body)
  ) {
    return undefined;
  }

  const diagnostics: RawLspDiagnostic[] = [];
  for (const item of value.body) {
    const diagnostic = parseTsServerDiagnostic(item);
    if (!diagnostic) return undefined;
    diagnostics.push(diagnostic);
  }
  return { diagnostics };
}

function parseTsServerDiagnostic(value: unknown): RawLspDiagnostic | undefined {
  if (!isRecord(value) || typeof value.text !== "string") return undefined;
  const start = tsServerPositionToLsp(value.start);
  const end = tsServerPositionToLsp(value.end);
  const range = start && end ? { start, end } : undefined;
  if (!range || !isLspRange(range)) return undefined;
  if (value.code !== undefined && typeof value.code !== "string" && !isLspInteger(value.code)) return undefined;
  if (value.source !== undefined && typeof value.source !== "string") return undefined;

  return {
    range,
    severity: tsServerDiagnosticSeverity(value.category),
    code: value.code as string | number | undefined,
    source: typeof value.source === "string" ? value.source : "typescript",
    message: value.text,
    relatedInformation: parseTsServerRelatedInformation(value.relatedInformation),
  };
}

function tsServerPositionToLsp(value: unknown): { line: number; character: number } | undefined {
  if (!isRecord(value) || !isOneBasedLspInteger(value.line) || !isOneBasedLspInteger(value.offset)) return undefined;
  return { line: value.line - 1, character: value.offset - 1 };
}

function isOneBasedLspInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 2_147_483_648;
}

function tsServerDiagnosticSeverity(value: unknown): number {
  switch (value) {
    case "warning":
      return 2;
    case "suggestion":
      return 4;
    case "error":
    default:
      return 1;
  }
}

function parseTsServerRelatedInformation(value: unknown): RawRelatedInformation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const related: RawRelatedInformation[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.message !== "string" || !isRecord(item.span) || typeof item.span.file !== "string") {
      continue;
    }
    const start = tsServerPositionToLsp(item.span.start);
    const end = tsServerPositionToLsp(item.span.end);
    const range = start && end ? { start, end } : undefined;
    if (!range || !isLspRange(range)) continue;
    related.push({
      location: { uri: filePathToUri(item.span.file), range },
      message: item.message,
    });
  }
  return related.length > 0 ? related : undefined;
}

function copyRawLspDiagnostic(diagnostic: RawLspDiagnostic): RawLspDiagnostic {
  return {
    range: {
      start: { line: diagnostic.range.start.line, character: diagnostic.range.start.character },
      end: { line: diagnostic.range.end.line, character: diagnostic.range.end.character },
    },
    severity: diagnostic.severity,
    code: diagnostic.code,
    source: diagnostic.source,
    message: diagnostic.message,
    relatedInformation: diagnostic.relatedInformation?.map((related) => ({
      location: {
        uri: related.location.uri,
        range: {
          start: { line: related.location.range.start.line, character: related.location.range.start.character },
          end: { line: related.location.range.end.line, character: related.location.range.end.character },
        },
      },
      message: related.message,
    })),
  };
}

function workspaceDiagnosticReportBytes(report: ParsedWorkspaceDocumentDiagnosticReport): number {
  let bytes = Buffer.byteLength(report.uri, "utf8") + Buffer.byteLength(report.resultId ?? "", "utf8") + 32;
  for (const diagnostic of report.diagnostics ?? []) {
    bytes += Buffer.byteLength(diagnostic.message, "utf8") +
      Buffer.byteLength(diagnostic.source ?? "", "utf8") +
      Buffer.byteLength(String(diagnostic.code ?? ""), "utf8") +
      64;
    for (const related of diagnostic.relatedInformation ?? []) {
      bytes += Buffer.byteLength(related.location.uri, "utf8") + Buffer.byteLength(related.message, "utf8") + 48;
    }
  }
  return bytes;
}

function isRawLspDiagnostic(value: unknown): value is RawLspDiagnostic {
  if (!isRecord(value) || !isLspRange(value.range) || typeof value.message !== "string") return false;
  if (value.severity !== undefined && !isDiagnosticSeverity(value.severity)) return false;
  if (value.code !== undefined && typeof value.code !== "string" && !isLspInteger(value.code)) return false;
  if (value.source !== undefined && typeof value.source !== "string") return false;
  if (value.relatedInformation !== undefined && (
    !Array.isArray(value.relatedInformation) ||
    !value.relatedInformation.every(isRawRelatedInformation)
  )) return false;
  if (value.tags !== undefined && (
    !Array.isArray(value.tags) ||
    !value.tags.every((tag) => tag === 1 || tag === 2)
  )) return false;
  if (value.codeDescription !== undefined && (
    !isRecord(value.codeDescription) ||
    typeof value.codeDescription.href !== "string"
  )) return false;
  return true;
}

function isRawRelatedInformation(value: unknown): value is RawRelatedInformation {
  return isRecord(value) &&
    isRecord(value.location) &&
    typeof value.location.uri === "string" &&
    value.location.uri.length > 0 &&
    isLspRange(value.location.range) &&
    typeof value.message === "string";
}

function isDiagnosticSeverity(value: unknown): value is number {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function isLspInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647;
}

function isRequestTimeout(error: unknown, method: string): boolean {
  return error instanceof Error && error.message === `LSP request timed out: ${method}`;
}

function remainingDiagnosticTimeout(timeoutMs: number, startedAt: number): number {
  return Math.max(0, timeoutMs - (Date.now() - startedAt));
}

function remainingUntil(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

function createDeadlineSignal(deadlineAt: number, parent?: AbortSignal): DeadlineSignal {
  const controller = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const expire = () => {
    if (controller.signal.aborted) return;
    timedOut = true;
    const error = new Error("Workspace diagnostic deadline exceeded");
    error.name = "AbortError";
    controller.abort(error);
  };
  const onParentAbort = () => {
    if (!controller.signal.aborted) controller.abort(parent?.reason);
  };

  if (parent) {
    parent.addEventListener("abort", onParentAbort, { once: true });
    if (parent.aborted) onParentAbort();
  }
  if (!controller.signal.aborted) {
    const remaining = remainingUntil(deadlineAt);
    if (remaining <= 0) expire();
    else {
      timer = setTimeout(expire, remaining);
      timer.unref();
    }
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function workspaceDocumentOutcomeMap(
  documents: readonly WorkspaceDiagnosticDocument[],
  protocol: WorkspaceDocumentDiagnosticProtocol,
  outcome: "timed-out" | "unavailable",
  reason: string,
): Map<string, WorkspaceDocumentDiagnosticResult> {
  return new Map(documents.map((document) => [
    filePathToUri(document.filePath),
    { outcome, protocol, reason },
  ]));
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
  forceKill.unref();
  child.once("exit", () => clearTimeout(forceKill));
}

async function terminateProcessAndWait(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  terminateProcess(child);
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, PROCESS_KILL_GRACE_MS + 250);
    timeout.unref();
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function isTransientInitializationFailure(error: unknown, signal?: AbortSignal): boolean {
  if (isCancellation(error, signal)) return true;
  if (!(error instanceof Error)) return false;
  return error.message === "LSP request timed out: initialize" ||
    error.message.startsWith("LSP initialization was superseded:");
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

