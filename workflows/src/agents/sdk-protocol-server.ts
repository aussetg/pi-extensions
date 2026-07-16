import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import { ArtifactStore } from "../artifacts/store.js";
import { canonicalJsonValue } from "../definition/canonical-json.js";
import {
  RunDatabase,
  RunDatabaseStateError,
  RunRevisionConflictError,
} from "../persistence/run-database.js";
import type {
  AgentFinishRecord,
  AgentMediatedToolName,
  AgentProgress,
  AgentProgressEvent,
  AgentToolReceiptRecord,
  ResourceMeasurement,
} from "../runtime/durable-types.js";
import { AGENT_PROGRESS_LIMITS } from "../runtime/agent-progress-limits.js";
import {
  CgroupMetricsUnavailableError,
  readCgroupMetrics,
  toResourceMeasurement,
} from "../systemd/cgroup-metrics.js";
import type { JsonObject, JsonSchema, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import type { AgentEvent, AgentEventSink, AgentProtocolHandle } from "./executor.js";
import {
  AGENT_SDK_PROTOCOL_MAX_LINE_BYTES,
  agentProtocolSocketPath,
  executionIdentifier,
  parseAgentProtocolClientMessage,
  protocolErrorBody,
  protocolFailure,
  type AgentProtocolClientMessage,
  type AgentProtocolServerMessage,
} from "./sdk-protocol.js";
import { buildFinishWorkContract } from "./sdk-tools.js";
import {
  assertMediatedWorkspace,
  validateMediatedPayload,
  type AgentMediatedToolExecutor,
  type AgentProtocolWorkspaceAuthority,
} from "./mediation.js";
import { AgentLiveProgressProjector } from "./live-progress.js";
import {
  boundedAgentText,
  exactAgentObject,
  finishResponse,
  parseProgressPayload,
  publishedArtifacts,
} from "./sdk-protocol-values.js";

const MAX_COMMIT_RETRIES = 16;

export interface AgentProtocolExecutionBinding {
  executionId: string;
  agentSessionId: string;
  operationId: string;
  attemptId: string;
  outputSchema?: JsonSchema;
  resultMode: "value" | "artifact" | "value-and-artifact";
  maximumArtifactBytes?: number;
  executionToken?: string;
  workspace?: AgentProtocolWorkspaceAuthority;
  network?: "none" | "research";
  /** Exact cgroup-v2 path owned by the transient agent unit. */
  controlGroup?: string;
}

export interface AgentProtocolServerOptions {
  now?: () => Date;
  eventSink?: AgentEventSink;
  mediatedTools?: AgentMediatedToolExecutor;
  resourceSampler?: (
    binding: Readonly<Pick<AgentProtocolExecutionBinding, "executionId" | "agentSessionId" | "operationId" | "attemptId" | "controlGroup">>,
    event: AgentEvent,
  ) => Promise<ResourceMeasurement | undefined>;
  cgroupRoot?: string;
  resourceSampleIntervalMs?: number;
}

interface AuthorizedExecution extends AgentProtocolExecutionBinding {
  executionToken: string;
  outputRoot: string;
  finishSchema: JsonSchema;
  finishSchemaHash: string;
  schemaLess: boolean;
  validateFinish: ValidateFunction;
  queue: Promise<void>;
}

interface ConnectionState {
  binding?: AuthorizedExecution;
  eventSequence: number;
  buffer: string;
  chain: Promise<void>;
}

/** Coordinator-owned endpoint for every model-callable terminal/progress tool. */
export class AgentProtocolServer implements AsyncDisposable {
  readonly runDir: string;
  readonly socketPath: string;
  readonly database: RunDatabase;
  private readonly now: () => Date;
  private readonly eventSink?: AgentEventSink;
  private readonly mediatedTools?: AgentMediatedToolExecutor;
  private readonly resourceSampler?: AgentProtocolServerOptions["resourceSampler"];
  private readonly cgroupRoot: string;
  private readonly resourceSampleIntervalMs: number;
  private readonly lastResourceSample = new Map<string, number>();
  private readonly progressProjector: AgentLiveProgressProjector;
  private readonly artifactStore: ArtifactStore;
  private readonly authorized = new Map<string, AuthorizedExecution>();
  private readonly sockets = new Set<net.Socket>();
  private server?: net.Server;

  constructor(runDirInput: string, database: RunDatabase, options: AgentProtocolServerOptions = {}) {
    this.database = database;
    this.runDir = path.resolve(runDirInput);
    if (path.resolve(database.databasePath) !== path.join(this.runDir, "run.sqlite")) {
      throw new Error("Agent protocol server and run database directories differ");
    }
    this.socketPath = agentProtocolSocketPath(this.runDir);
    this.now = options.now ?? (() => new Date());
    this.eventSink = options.eventSink;
    this.mediatedTools = options.mediatedTools;
    this.resourceSampler = options.resourceSampler;
    this.cgroupRoot = options.cgroupRoot ?? "/sys/fs/cgroup";
    this.resourceSampleIntervalMs = options.resourceSampleIntervalMs ?? 500;
    if (!Number.isSafeInteger(this.resourceSampleIntervalMs)
      || this.resourceSampleIntervalMs < 100
      || this.resourceSampleIntervalMs > 10_000) {
      throw new TypeError("Invalid agent resource sample interval");
    }
    this.progressProjector = new AgentLiveProgressProjector(database);
    this.artifactStore = new ArtifactStore(this.runDir, database, {
      maximumArtifactBytes: database.readRun().safety.outputBytes,
      now: this.now,
    });
  }

  async start(): Promise<void> {
    if (this.server) return;
    await assertPrivateRunDirectory(this.runDir);
    await removeStaleSocket(this.socketPath);
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await fs.promises.chmod(this.socketPath, 0o600);
      const stat = await fs.promises.lstat(this.socketPath);
      if (!stat.isSocket() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        throw new Error("Agent protocol socket is not private");
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async authorize(binding: AgentProtocolExecutionBinding): Promise<AgentProtocolHandle> {
    if (!this.server) throw new Error("Agent protocol server is not started");
    executionIdentifier(binding.executionId);
    if (!["value", "artifact", "value-and-artifact"].includes(binding.resultMode)) {
      throw new TypeError("Invalid agent result mode");
    }
    if (
      binding.maximumArtifactBytes !== undefined
      && (!Number.isSafeInteger(binding.maximumArtifactBytes) || binding.maximumArtifactBytes < 1
        || binding.maximumArtifactBytes > this.database.readRun().safety.outputBytes)
    ) throw new TypeError("Invalid agent artifact byte limit");
    for (const [label, value] of [["session", binding.agentSessionId], ["operation", binding.operationId], ["attempt", binding.attemptId]] as const) {
      if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new TypeError(`Invalid agent ${label} id`);
    }
    if (binding.controlGroup !== undefined
      && !/^\/(?:[A-Za-z0-9_.:@-]+\/)*[A-Za-z0-9_.:@-]+$/.test(binding.controlGroup)) {
      throw new TypeError("Invalid agent cgroup path");
    }
    const session = this.database.readAgentSession(binding.agentSessionId);
    const attempt = this.database.readAttempt(binding.attemptId);
    if (
      !session
      || session.operationId !== binding.operationId
      || session.currentExecutionId !== binding.executionId
      || (session.status !== "running" && session.status !== "waiting")
      || !attempt
      || attempt.operationId !== binding.operationId
      || attempt.executionId !== binding.executionId
    ) throw new RunDatabaseStateError("Agent protocol authority does not match durable execution state");

    const contract = buildFinishWorkContract(binding.outputSchema);
    const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true, validateSchema: true });
    if (!ajv.validateSchema(contract.parameters)) {
      throw new TypeError(`Invalid finish_work schema: ${ajv.errorsText(ajv.errors)}`);
    }
    const executionToken = binding.executionToken ?? crypto.randomBytes(32).toString("hex");
    if (!/^[a-f0-9]{64}$/.test(executionToken)) throw new TypeError("Invalid agent execution token");
    const outputRoot = path.join(this.runDir, "outputs", binding.executionId);
    await ensurePrivateOutputRoot(this.runDir, outputRoot);
    if (binding.workspace) await assertMediatedWorkspace(binding.workspace);
    const prior = this.authorized.get(binding.executionId);
    if (prior && prior.executionToken !== executionToken) {
      throw new Error(`Agent execution ${binding.executionId} is already authorized`);
    }
    this.authorized.set(binding.executionId, {
      ...binding,
      executionToken,
      outputRoot,
      finishSchema: contract.parameters,
      finishSchemaHash: contract.schemaHash,
      schemaLess: contract.schemaLess,
      validateFinish: ajv.compile(contract.parameters),
      queue: Promise.resolve(),
    });
    return { socketPath: this.socketPath, executionToken };
  }

  revoke(executionId: string): void {
    const id = executionIdentifier(executionId);
    this.authorized.delete(id);
    this.lastResourceSample.delete(id);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
    }
    await fs.promises.rm(this.socketPath, { force: true }).catch(() => undefined);
  }

  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    const state: ConnectionState = { eventSequence: 0, buffer: "", chain: Promise.resolve() };
    socket.on("data", (chunk: string) => this.consume(socket, state, chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => this.sockets.delete(socket));
  }

  private consume(socket: net.Socket, state: ConnectionState, chunk: string): void {
    state.buffer += chunk;
    if (Buffer.byteLength(state.buffer) > AGENT_SDK_PROTOCOL_MAX_LINE_BYTES) {
      this.rejectAuthentication(socket, protocolFailure("line-too-large", "Agent protocol request exceeded its bound"));
      return;
    }
    let newline: number;
    while ((newline = state.buffer.indexOf("\n")) >= 0) {
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      if (!line) continue;
      state.chain = state.chain.then(async () => {
        let message: AgentProtocolClientMessage;
        try { message = parseAgentProtocolClientMessage(JSON.parse(line)); }
        catch (error) {
          if (!state.binding) this.rejectAuthentication(socket, error);
          else socket.destroy();
          return;
        }
        if (!state.binding) {
          if (message.type !== "authenticate") {
            this.rejectAuthentication(socket, protocolFailure("authentication", "Authenticate before sending agent requests"));
            return;
          }
          const binding = this.authorized.get(message.executionId);
          if (!binding || !sameSecret(binding.executionToken, message.executionToken)) {
            this.rejectAuthentication(socket, protocolFailure("authentication", "Agent execution authentication failed"));
            return;
          }
          state.binding = binding;
          this.send(socket, { type: "authenticated", protocolVersion: 1, ok: true });
          return;
        }
        if (message.type === "authenticate") {
          socket.destroy();
          return;
        }
        if (message.type === "agent-event") {
          try {
            const event = validateEvidenceEvent(message.event, state.binding, state.eventSequence + 1);
            state.eventSequence = event.sequence;
            const resources = await this.sampleResources(state.binding, event);
            await this.progressProjector.emit(event, resources);
            await this.eventSink?.emit(event);
            this.send(socket, { type: "response", protocolVersion: 1, requestId: message.requestId, ok: true, result: null });
          } catch (error) {
            this.sendFailure(socket, message.requestId, error);
          }
          return;
        }
        try {
          const result = await this.serialize(state.binding, async () => await this.handleToolRequest(state.binding!, message));
          this.send(socket, { type: "response", protocolVersion: 1, requestId: message.requestId, ok: true, result });
        } catch (error) {
          this.sendFailure(socket, message.requestId, error);
        }
      }).catch(() => { socket.destroy(); });
    }
  }

  private async serialize<T>(binding: AuthorizedExecution, work: () => Promise<T>): Promise<T> {
    const prior = binding.queue;
    let release!: () => void;
    binding.queue = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await work(); }
    finally { release(); }
  }

  private async sampleResources(binding: AuthorizedExecution, event: AgentEvent): Promise<ResourceMeasurement | undefined> {
    const sampledAt = Date.parse(event.at);
    const prior = this.lastResourceSample.get(binding.executionId);
    const forced = event.type === "model-end" || event.type === "workspace-change" || event.type === "termination";
    if (!forced && prior !== undefined && sampledAt - prior < this.resourceSampleIntervalMs) return undefined;
    if (this.resourceSampler) {
      const resources = await this.resourceSampler(binding, event);
      if (resources) this.lastResourceSample.set(binding.executionId, sampledAt);
      return resources;
    }
    if (!binding.controlGroup) return undefined;
    try {
      const resources = toResourceMeasurement(await readCgroupMetrics(binding.controlGroup, this.cgroupRoot));
      this.lastResourceSample.set(binding.executionId, sampledAt);
      return resources;
    } catch (error) {
      if (error instanceof CgroupMetricsUnavailableError) return undefined;
      throw error;
    }
  }

  private async handleToolRequest(
    binding: AuthorizedExecution,
    message: Extract<AgentProtocolClientMessage, { type: "tool-request" }>,
  ): Promise<JsonValue> {
    const requestHash = stableHash({
      protocolVersion: 1,
      toolName: message.toolName,
      payload: message.payload,
      ...(message.toolName === "finish_work" ? { schemaHash: binding.finishSchemaHash } : {}),
    });
    const existing = this.database.readAgentToolReceipt(binding.agentSessionId, message.toolCallId);
    if (existing) return matchingReceipt(existing, binding, message.toolName, requestHash).response;

    if (message.toolName === "web_search" || message.toolName === "web_fetch" || message.toolName === "workspace_command") {
      return await this.mediatedTool(binding, message.toolCallId, message.toolName, requestHash, message.payload);
    }

    switch (message.toolName) {
      case "report_progress":
        return await this.reportProgress(binding, message.toolCallId, requestHash, message.payload);
      case "log_result":
        return await this.logResult(binding, message.toolCallId, requestHash, message.payload);
      case "publish_artifact":
        return await this.publishArtifact(binding, message.toolCallId, requestHash, message.payload);
      case "finish_work":
        return await this.finishWork(binding, message.toolCallId, requestHash, message.payload);
    }
  }

  private async mediatedTool(
    binding: AuthorizedExecution,
    toolCallId: string,
    toolName: AgentMediatedToolName,
    requestHash: string,
    payload: JsonValue,
  ): Promise<JsonValue> {
    if (!this.mediatedTools) throw protocolFailure("mediator-unavailable", `${toolName} mediator is unavailable`, true);
    if (!binding.workspace) throw protocolFailure("authority", `${toolName} has no bound workspace authority`);
    if ((toolName === "web_search" || toolName === "web_fetch") && binding.network !== "research") {
      throw protocolFailure("authority", `${toolName} requires mediated research authority`);
    }
    if (toolName === "workspace_command" && binding.workspace.mode !== "candidate") {
      throw protocolFailure("authority", "workspace_command requires a candidate workspace");
    }
    validateMediatedPayload(toolName, payload);
    const response = canonicalJsonValue(await this.mediatedTools.execute({
      toolName,
      toolCallId,
      payload,
      runDir: this.runDir,
      executionId: binding.executionId,
      operationId: binding.operationId,
      attemptId: binding.attemptId,
      outputRoot: binding.outputRoot,
      workspace: binding.workspace,
    }), {
      maxBytes: Math.min(this.database.readRun().safety.outputBytes, 1024 * 1024),
      maxDepth: 32,
      maxNodes: 20_000,
      maxStringScalars: 512_000,
    });
    const committedAt = this.timestamp();
    for (let attempt = 0; attempt < MAX_COMMIT_RETRIES; attempt += 1) {
      const existing = this.database.readAgentToolReceipt(binding.agentSessionId, toolCallId);
      if (existing) return matchingReceipt(existing, binding, toolName, requestHash).response;
      const current = requiredSessionProgress(this.database, binding.agentSessionId);
      try {
        return this.database.commitAgentMediatedTool({
          expectedRevision: this.database.readRun().revision,
          agentSessionId: binding.agentSessionId,
          executionId: binding.executionId,
          toolCallId,
          toolName,
          requestHash,
          response,
          committedAt,
          progress: { ...current, updatedAt: committedAt },
        }).receipt.response;
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw protocolFailure("revision-race", `Could not commit ${toolName} after repeated revision races`, true);
  }

  private async reportProgress(
    binding: AuthorizedExecution,
    toolCallId: string,
    requestHash: string,
    payloadValue: JsonValue,
  ): Promise<JsonValue> {
    const payload = parseProgressPayload(payloadValue);
    const at = this.timestamp();
    const current = requiredSessionProgress(this.database, binding.agentSessionId);
    const progress: AgentProgress = {
      message: payload.message,
      ...(payload.current !== undefined ? { current: payload.current } : {}),
      ...(payload.total !== undefined ? { total: payload.total } : {}),
      metrics: payload.metrics ?? [],
      usage: current.usage,
      modelTurn: current.modelTurn,
      ...(current.currentTool ? { currentTool: current.currentTool } : {}),
      toolCount: current.toolCount,
      retries: current.retries,
      workspaceChanged: current.workspaceChanged,
      workspaceChangeCount: current.workspaceChangeCount,
      recentWorkspaceChanges: current.recentWorkspaceChanges,
      ...(current.resources ? { resources: current.resources } : {}),
      updatedAt: at,
    };
    const progressEvent: AgentProgressEvent = {
      type: "report",
      message: payload.message,
      ...(payload.current !== undefined ? { current: payload.current } : {}),
      ...(payload.total !== undefined ? { total: payload.total } : {}),
      ...(payload.metrics ? { metrics: payload.metrics } : {}),
    };
    const response: JsonValue = { recorded: true };
    return (await this.commitProgress(binding, toolCallId, "report_progress", requestHash, response, progress, progressEvent)).response;
  }

  private async logResult(
    binding: AuthorizedExecution,
    toolCallId: string,
    requestHash: string,
    payloadValue: JsonValue,
  ): Promise<JsonValue> {
    const payload = exactAgentObject(payloadValue, ["message"], "log_result");
    const message = boundedAgentText(payload.message, "log_result message", AGENT_PROGRESS_LIMITS.logScalars);
    const at = this.timestamp();
    const progress = { ...requiredSessionProgress(this.database, binding.agentSessionId), updatedAt: at };
    const response: JsonValue = { recorded: true };
    return (await this.commitProgress(
      binding,
      toolCallId,
      "log_result",
      requestHash,
      response,
      progress,
      { type: "log", message },
    )).response;
  }

  private async publishArtifact(
    binding: AuthorizedExecution,
    toolCallId: string,
    requestHash: string,
    payloadValue: JsonValue,
  ): Promise<JsonValue> {
    const payload = exactAgentObject(payloadValue, ["path", "content", "name", "format"], "publish_artifact", true);
    if ((payload.path === undefined) === (payload.content === undefined)) {
      throw new TypeError("publish_artifact requires exactly one of path or content");
    }
    const name = payload.name === undefined ? undefined : boundedAgentText(payload.name, "artifact name", 128);
    const kind = "agent-published";
    const format = payload.format ?? "file";
    if (format !== "file" && format !== "text" && format !== "json") throw new TypeError("Artifact format must be file, text, or json");
    const metadata: JsonObject = {};
    const maximumBytes = Math.min(
      binding.maximumArtifactBytes ?? this.database.readRun().safety.outputBytes,
      this.database.readRun().safety.outputBytes,
    );
    let stored: Awaited<ReturnType<ArtifactStore["putText"]>>;
    if (payload.content !== undefined) {
      if (format === "file") throw new TypeError("Inline artifact content must use text or json format");
      const content = boundedAgentText(payload.content, "artifact content", 1_000_000);
      if (Buffer.byteLength(content) > maximumBytes) throw new TypeError("Inline artifact content exceeds its byte limit");
      stored = format === "json"
        ? await this.artifactStore.putJson({
            expectedRevision: this.database.readRun().revision,
            kind,
            value: JSON.parse(content) as JsonValue,
            metadata,
            maximumBytes,
            createdAt: this.timestamp(),
          })
        : await this.artifactStore.putText({
            expectedRevision: this.database.readRun().revision,
            kind,
            text: content,
            metadata,
            maximumBytes,
            createdAt: this.timestamp(),
          });
    } else {
      const relativePath = safePublicationPath(payload.path);
      const sourcePath = await safeOutputFile(binding.outputRoot, relativePath, binding.maximumArtifactBytes);
      stored = await this.storePublication(format, sourcePath, kind, metadata, maximumBytes);
    }
    const response: JsonValue = { artifact: stored.artifact } as unknown as JsonValue;
    const at = this.timestamp();
    const progress = { ...requiredSessionProgress(this.database, binding.agentSessionId), updatedAt: at };
    return (await this.commitProgress(
      binding,
      toolCallId,
      "publish_artifact",
      requestHash,
      response,
      progress,
      { type: "artifact", artifact: stored.artifact, ...(name ? { name } : {}) },
    )).response;
  }

  private async finishWork(
    binding: AuthorizedExecution,
    toolCallId: string,
    requestHash: string,
    payload: JsonValue,
  ): Promise<JsonValue> {
    if (!binding.validateFinish(payload)) {
      const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
      throw new TypeError(`finish_work arguments do not match the operation schema: ${ajv.errorsText(binding.validateFinish.errors)}`);
    }
    const canonical = canonicalJsonValue(payload, {
      maxBytes: this.database.readRun().safety.outputBytes,
      maxDepth: 64,
      maxNodes: 100_000,
      maxStringScalars: this.database.readRun().safety.outputBytes,
    });
    const artifacts = publishedArtifacts(this.database.listAgentToolReceipts(binding.agentSessionId));
    if ((binding.resultMode === "artifact" || binding.resultMode === "value-and-artifact") && artifacts.length === 0) {
      throw new TypeError(`${binding.resultMode} completion requires a published artifact`);
    }
    const at = this.timestamp();
    const value = binding.resultMode === "artifact"
      ? undefined
      : binding.schemaLess
        ? (canonical as JsonObject).result
        : canonical;
    const finish: AgentFinishRecord = {
      toolCallId,
      schemaHash: binding.finishSchemaHash,
      ...(value !== undefined ? { value } : {}),
      artifacts,
      committedAt: at,
    };
    const response = finishResponse(finish);
    for (let attempt = 0; attempt < MAX_COMMIT_RETRIES; attempt += 1) {
      const existing = this.database.readAgentToolReceipt(binding.agentSessionId, toolCallId);
      if (existing) return matchingReceipt(existing, binding, "finish_work", requestHash).response;
      try {
        return this.database.commitAgentFinishTool({
          expectedRevision: this.database.readRun().revision,
          agentSessionId: binding.agentSessionId,
          executionId: binding.executionId,
          toolCallId,
          toolName: "finish_work",
          requestHash,
          response,
          committedAt: at,
          finish,
        }).receipt.response;
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw protocolFailure("revision-race", "Could not commit finish_work after repeated revision races", true);
  }

  private async commitProgress(
    binding: AuthorizedExecution,
    toolCallId: string,
    toolName: "report_progress" | "log_result" | "publish_artifact",
    requestHash: string,
    response: JsonValue,
    progress: AgentProgress,
    progressEvent: AgentProgressEvent,
  ): Promise<AgentToolReceiptRecord> {
    const committedAt = progress.updatedAt;
    for (let attempt = 0; attempt < MAX_COMMIT_RETRIES; attempt += 1) {
      const existing = this.database.readAgentToolReceipt(binding.agentSessionId, toolCallId);
      if (existing) return matchingReceipt(existing, binding, toolName, requestHash);
      try {
        return this.database.commitAgentProgressTool({
          expectedRevision: this.database.readRun().revision,
          agentSessionId: binding.agentSessionId,
          executionId: binding.executionId,
          toolCallId,
          toolName,
          requestHash,
          response,
          committedAt,
          progress,
          progressEvent,
        }).receipt;
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw protocolFailure("revision-race", `Could not commit ${toolName} after repeated revision races`, true);
  }

  private async storePublication(
    format: "file" | "text" | "json",
    sourcePath: string,
    kind: string,
    metadata: JsonObject,
    maximumBytes: number,
  ) {
    const createdAt = this.timestamp();
    for (let attempt = 0; attempt < MAX_COMMIT_RETRIES; attempt += 1) {
      const common = {
        expectedRevision: this.database.readRun().revision,
        kind,
        metadata,
        maximumBytes,
        createdAt,
      };
      try {
        if (format === "file") return await this.artifactStore.putFile({ ...common, filePath: sourcePath });
        const source = await readSafeText(sourcePath, maximumBytes);
        if (format === "text") return await this.artifactStore.putText({ ...common, text: source });
        let value: JsonValue;
        try { value = JSON.parse(source) as JsonValue; }
        catch { throw new TypeError("Published JSON artifact is not valid JSON"); }
        return await this.artifactStore.putJson({ ...common, value });
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw protocolFailure("revision-race", "Could not publish artifact after repeated revision races", true);
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Agent protocol clock returned an invalid date");
    return value.toISOString();
  }

  private rejectAuthentication(socket: net.Socket, error: unknown): void {
    this.send(socket, { type: "authenticated", protocolVersion: 1, ok: false, error: protocolErrorBody(error) });
    socket.end();
  }

  private sendFailure(socket: net.Socket, requestId: string, error: unknown): void {
    this.send(socket, { type: "response", protocolVersion: 1, requestId, ok: false, error: protocolErrorBody(error) });
  }

  private send(socket: net.Socket, message: AgentProtocolServerMessage): void {
    const line = `${stableJson(message)}\n`;
    if (Buffer.byteLength(line) > AGENT_SDK_PROTOCOL_MAX_LINE_BYTES) {
      socket.destroy();
      return;
    }
    socket.write(line);
  }
}

function matchingReceipt(
  receipt: AgentToolReceiptRecord,
  binding: AuthorizedExecution,
  toolName: AgentToolReceiptRecord["toolName"],
  requestHash: string,
): AgentToolReceiptRecord {
  if (
    receipt.executionId !== binding.executionId
    || receipt.toolName !== toolName
    || receipt.requestHash !== requestHash
  ) throw protocolFailure("conflicting-duplicate", `Conflicting duplicate ${toolName} call ${receipt.toolCallId}`);
  return receipt;
}

function requiredSessionProgress(database: RunDatabase, agentSessionId: string): AgentProgress {
  const session = database.readAgentSession(agentSessionId);
  if (!session) throw new RunDatabaseStateError(`Unknown agent session ${agentSessionId}`);
  return session.progress;
}

function validateEvidenceEvent(value: JsonValue, binding: AuthorizedExecution, expectedSequence: number): AgentEvent {
  const event = value as unknown as AgentEvent;
  if (
    !event
    || typeof event !== "object"
    || event.executionId !== binding.executionId
    || event.operationId !== binding.operationId
    || event.attemptId !== binding.attemptId
    || event.sequence !== expectedSequence
    || typeof event.at !== "string"
    || !Number.isFinite(Date.parse(event.at))
  ) throw protocolFailure("invalid-event", "Agent event identity, sequence, or timestamp is invalid");
  if (![
    "execution-start", "session-open", "model-start", "model-end", "assistant-text", "tool-start", "tool-update",
    "tool-end", "progress", "result-log", "artifact-published", "workspace-change", "compaction-start",
    "compaction-end", "provider-retry", "finish-requested", "finish-committed", "cancel-requested", "termination",
  ].includes(event.type)) throw protocolFailure("invalid-event", `Unknown agent event ${String((event as { type?: unknown }).type)}`);
  return event;
}

function safePublicationPath(value: unknown): string {
  const relative = boundedAgentText(value, "artifact path", 4_096).replaceAll("\\", "/");
  if (path.posix.isAbsolute(relative) || relative.startsWith("@") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw protocolFailure("unsafe-artifact-path", "Artifact path escapes the execution output directory");
  }
  return relative;
}

async function safeOutputFile(root: string, relative: string, maximumBytes?: number): Promise<string> {
  const rootStat = await fs.promises.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw protocolFailure("unsafe-artifact-path", "Execution output directory is unsafe");
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const stat = await fs.promises.lstat(current);
    if (stat.isSymbolicLink()) throw protocolFailure("unsafe-artifact-path", "Artifact path contains a symbolic link");
  }
  const resolved = path.resolve(root, relative);
  const contained = path.relative(root, resolved);
  if (contained.startsWith("..") || path.isAbsolute(contained)) throw protocolFailure("unsafe-artifact-path", "Artifact path escapes the output directory");
  const stat = await fs.promises.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw protocolFailure("unsafe-artifact-path", "Published artifact must be a regular file");
  if (maximumBytes !== undefined && stat.size > maximumBytes) throw new TypeError(`Published artifact exceeds ${maximumBytes} bytes`);
  return resolved;
}

async function readSafeText(filePath: string, maximum: number): Promise<string> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new TypeError("Published text artifact is unsafe or too large");
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const value = await handle.readFile();
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Published text artifact is not valid UTF-8");
  } finally {
    await handle.close();
  }
}

async function assertPrivateRunDirectory(runDir: string): Promise<void> {
  const [stat, real] = await Promise.all([fs.promises.lstat(runDir), fs.promises.realpath(runDir)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== runDir) throw new Error("Unsafe agent protocol run directory");
}

async function ensurePrivateOutputRoot(runDir: string, outputRoot: string): Promise<void> {
  const outputs = path.join(runDir, "outputs");
  await fs.promises.mkdir(outputs, { recursive: true, mode: 0o700 });
  const outputsStat = await fs.promises.lstat(outputs);
  if (!outputsStat.isDirectory() || outputsStat.isSymbolicLink()) throw new Error("Unsafe run output directory");
  await fs.promises.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const outputStat = await fs.promises.lstat(outputRoot);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error("Unsafe execution output directory");
  await fs.promises.chmod(outputRoot, 0o700);
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const stat = await fs.promises.lstat(socketPath);
    if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error("Refusing to replace a non-socket agent protocol path");
    await fs.promises.rm(socketPath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function sameSecret(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
