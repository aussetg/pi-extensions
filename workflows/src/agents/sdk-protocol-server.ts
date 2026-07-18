import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import type { WorkflowArtifactStore } from "../artifacts/store.js";
import type { WorkflowArtifactRecord } from "../persistence/run-database-types.js";
import type { WorkflowRunDatabase } from "../persistence/run-database.js";
import type { JsonObject, JsonSchema, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import type { AgentEvent, AgentEventSink, AgentProtocolHandle } from "./executor.js";
import type { AgentMediatedToolExecutor, AgentProtocolWorkspaceAuthority } from "./mediation.js";
import { assertMediatedWorkspace, validateMediatedPayload } from "./mediation.js";
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
import type { AgentFinishRecord, AgentMediatedToolName } from "../runtime/durable-types.js";

export interface AgentProtocolBinding {
  executionId: string;
  operationId: string;
  attemptId: string;
  outputSchema: JsonSchema;
  workspace: AgentProtocolWorkspaceAuthority;
  network: "none" | "research";
  signal?: AbortSignal;
}

interface AuthorizedExecution {
  binding: Omit<AgentProtocolBinding, "signal">;
  executionToken: string;
  outputRoot: string;
  validateFinish: ValidateFunction;
  finishSchemaHash: string;
  queue: Promise<void>;
  abort: AbortController;
  detach?: () => void;
}

interface ConnectionState {
  binding?: AuthorizedExecution;
  buffer: string;
  chain: Promise<void>;
}

interface DurableToolReceipt {
  formatVersion: 1;
  executionId: string;
  toolCallId: string;
  toolName: string;
  requestHash: string;
  response: JsonValue;
  committedAt: string;
}

/** Minimal schema-4 agent protocol authority with filesystem-durable tool receipts. */
export class AgentProtocolServer implements AsyncDisposable {
  readonly runDir: string;
  readonly socketPath: string;
  private readonly authorized = new Map<string, AuthorizedExecution>();
  private readonly sockets = new Set<net.Socket>();
  private server?: net.Server;

  constructor(
    runDir: string,
    readonly database: WorkflowRunDatabase,
    readonly artifacts: WorkflowArtifactStore,
    private readonly options: {
      mediatedTools?: AgentMediatedToolExecutor;
      eventSink?: AgentEventSink;
      now?: () => Date;
    } = {},
  ) {
    this.runDir = path.resolve(runDir);
    this.socketPath = agentProtocolSocketPath(this.runDir);
  }

  async start(): Promise<void> {
    if (this.server) return;
    const stat = await fs.promises.lstat(this.runDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe workflow agent protocol run directory");
    await fs.promises.rm(this.socketPath, { force: true });
    const server = net.createServer(socket => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => { server.off("error", reject); resolve(); });
    });
    await fs.promises.chmod(this.socketPath, 0o600);
  }

  async authorize(binding: AgentProtocolBinding): Promise<AgentProtocolHandle> {
    if (!this.server) throw new Error("Workflow agent protocol server is not started");
    executionIdentifier(binding.executionId);
    const operation = this.database.readOperation(binding.operationId);
    const attempt = this.database.readAttempt(binding.attemptId);
    if (!operation || !attempt || attempt.operationId !== operation.operationId
      || attempt.executionId !== binding.executionId || !["running", "waiting"].includes(attempt.status)) {
      throw new Error("Workflow agent protocol authority differs from its operation attempt");
    }
    await assertMediatedWorkspace(binding.workspace);
    const contract = buildFinishWorkContract(binding.outputSchema);
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    const state = await this.bindingState(binding.executionId);
    const abort = new AbortController();
    let detach: (() => void) | undefined;
    if (binding.signal) {
      const relay = () => abort.abort(binding.signal!.reason);
      if (binding.signal.aborted) relay();
      else { binding.signal.addEventListener("abort", relay, { once: true }); detach = () => binding.signal!.removeEventListener("abort", relay); }
    }
    const prior = this.authorized.get(binding.executionId);
    if (prior) throw new Error(`Workflow agent execution ${binding.executionId} is already authorized`);
    const { signal: _signal, ...publicBinding } = binding;
    this.authorized.set(binding.executionId, {
      binding: publicBinding,
      executionToken: state.executionToken,
      outputRoot: state.outputRoot,
      validateFinish: ajv.compile(contract.parameters),
      finishSchemaHash: contract.schemaHash,
      queue: Promise.resolve(),
      abort,
      ...(detach ? { detach } : {}),
    });
    return { socketPath: this.socketPath, executionToken: state.executionToken };
  }

  revoke(executionId: string): void {
    const binding = this.authorized.get(executionId);
    binding?.detach?.();
    binding?.abort.abort(new Error("Workflow agent execution was revoked"));
    this.authorized.delete(executionId);
  }

  async finish(executionId: string): Promise<AgentFinishRecord | undefined> {
    const receipts = await this.receipts(executionId);
    const finish = receipts.filter(receipt => receipt.toolName === "finish_work");
    if (finish.length > 1) throw new Error("Workflow agent execution has multiple finish receipts");
    const value = finish[0]?.response as JsonObject | undefined;
    return value ? parseFinishResponse(value) : undefined;
  }

  async published(executionId: string): Promise<WorkflowArtifactRecord[]> {
    const result: WorkflowArtifactRecord[] = [];
    for (const receipt of await this.receipts(executionId)) {
      if (receipt.toolName !== "publish_artifact") continue;
      const response = record(receipt.response, "published artifact receipt");
      const ref = record(response.artifact, "published artifact");
      const artifact = typeof ref.digest === "string" ? this.database.readArtifact(ref.digest) : undefined;
      if (!artifact) throw new Error("Published workflow artifact receipt is stale");
      result.push(artifact);
    }
    return result;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    for (const id of [...this.authorized.keys()]) this.revoke(id);
    if (server) await new Promise<void>(resolve => server.close(() => resolve())).catch(() => undefined);
    await fs.promises.rm(this.socketPath, { force: true }).catch(() => undefined);
  }

  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    const state: ConnectionState = { buffer: "", chain: Promise.resolve() };
    socket.on("data", (chunk: string) => this.consume(socket, state, chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => this.sockets.delete(socket));
  }

  private consume(socket: net.Socket, state: ConnectionState, chunk: string): void {
    state.buffer += chunk;
    if (Buffer.byteLength(state.buffer) > AGENT_SDK_PROTOCOL_MAX_LINE_BYTES) { socket.destroy(); return; }
    let newline: number;
    while ((newline = state.buffer.indexOf("\n")) >= 0) {
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      if (!line) continue;
      state.chain = state.chain.then(async () => {
        let message: AgentProtocolClientMessage;
        try { message = parseAgentProtocolClientMessage(JSON.parse(line)); }
        catch (error) { this.failure(socket, "authentication", error); return; }
        if (!state.binding) {
          if (message.type !== "authenticate") { this.failure(socket, "authentication", new Error("Authenticate first")); return; }
          const binding = this.authorized.get(message.executionId);
          if (!binding || !sameSecret(binding.executionToken, message.executionToken)) {
            this.failure(socket, "authentication", new Error("Agent authentication failed")); return;
          }
          state.binding = binding;
          this.send(socket, { type: "authenticated", protocolVersion: 1, ok: true });
          return;
        }
        if (message.type === "authenticate") { socket.destroy(); return; }
        if (message.type === "agent-event") {
          try {
            await this.options.eventSink?.emit(message.event as unknown as AgentEvent);
            this.send(socket, { type: "response", protocolVersion: 1, requestId: message.requestId, ok: true, result: null });
          } catch (error) { this.responseFailure(socket, message.requestId, error); }
          return;
        }
        const binding = state.binding;
        const prior = binding.queue;
        let release!: () => void;
        binding.queue = new Promise<void>(resolve => { release = resolve; });
        await prior;
        try {
          const result = await this.tool(binding, message);
          this.send(socket, { type: "response", protocolVersion: 1, requestId: message.requestId, ok: true, result });
        } catch (error) { this.responseFailure(socket, message.requestId, error); }
        finally { release(); }
      }).catch(() => { socket.destroy(); });
    }
  }

  private async tool(
    authorized: AuthorizedExecution,
    message: Extract<AgentProtocolClientMessage, { type: "tool-request" }>,
  ): Promise<JsonValue> {
    const requestHash = stableHash({ protocolVersion: 1, toolName: message.toolName, payload: message.payload,
      ...(message.toolName === "finish_work" ? { schemaHash: authorized.finishSchemaHash } : {}) });
    const existing = await this.readReceipt(authorized.binding.executionId, message.toolCallId);
    if (existing) {
      if (existing.toolName !== message.toolName || existing.requestHash !== requestHash) {
        throw protocolFailure("receipt-conflict", "Agent tool call id changed request identity");
      }
      return structuredClone(existing.response);
    }
    authorized.abort.signal.throwIfAborted();
    let response: JsonValue;
    if (message.toolName === "finish_work") {
      if (!authorized.validateFinish(message.payload)) {
        throw protocolFailure("finish-schema", `finish_work output is invalid: ${new Ajv().errorsText(authorized.validateFinish.errors)}`);
      }
      const finish: AgentFinishRecord = {
        toolCallId: message.toolCallId,
        schemaHash: authorized.finishSchemaHash,
        value: structuredClone(message.payload),
        artifacts: (await this.published(authorized.binding.executionId)).map(artifactRef),
        committedAt: this.timestamp(),
      };
      response = { finish: finish as unknown as JsonValue };
    } else if (message.toolName === "publish_artifact") {
      response = await this.publish(authorized, message.payload);
    } else if (message.toolName === "report_progress" || message.toolName === "log_result") {
      response = { committed: true };
    } else {
      response = await this.mediated(authorized, message.toolName, message.toolCallId, message.payload);
    }
    const receipt: DurableToolReceipt = {
      formatVersion: 1,
      executionId: authorized.binding.executionId,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      requestHash,
      response,
      committedAt: this.timestamp(),
    };
    await this.writeReceipt(receipt);
    return structuredClone(response);
  }

  private async publish(authorized: AuthorizedExecution, value: JsonValue): Promise<JsonValue> {
    const payload = record(value, "publish_artifact");
    const hasPath = typeof payload.path === "string";
    const hasContent = typeof payload.content === "string";
    if (hasPath === hasContent) throw new TypeError("publish_artifact requires exactly one of path or content");
    const format = payload.format === undefined ? (hasPath ? "file" : "text") : payload.format;
    let stored: Awaited<ReturnType<WorkflowArtifactStore["putText"]>>;
    if (hasPath) {
      const source = contained(authorized.outputRoot, payload.path as string);
      stored = await this.artifacts.putFile({ kind: "agent-published", filePath: source,
        metadata: typeof payload.name === "string" ? { name: payload.name } : {} });
    } else if (format === "json") {
      let parsed: JsonValue;
      try { parsed = JSON.parse(payload.content as string) as JsonValue; }
      catch { throw new TypeError("Published JSON content is invalid"); }
      stored = await this.artifacts.putJson({ kind: "agent-published", value: parsed,
        metadata: typeof payload.name === "string" ? { name: payload.name } : {} });
    } else {
      stored = await this.artifacts.putText({ kind: "agent-published", text: payload.content as string,
        metadata: typeof payload.name === "string" ? { name: payload.name } : {} });
    }
    return { artifact: artifactRef(stored.record) as unknown as JsonValue };
  }

  private async mediated(
    authorized: AuthorizedExecution,
    toolName: AgentMediatedToolName,
    toolCallId: string,
    payload: JsonValue,
  ): Promise<JsonValue> {
    if (!this.options.mediatedTools) throw protocolFailure("mediator-unavailable", `${toolName} is unavailable`, true);
    if ((toolName === "web_search" || toolName === "web_fetch") && authorized.binding.network !== "research") {
      throw protocolFailure("authority", `${toolName} requires research authority`);
    }
    if (toolName === "workspace_command" && authorized.binding.workspace.mode !== "candidate") {
      throw protocolFailure("authority", "workspace_command requires candidate authority");
    }
    validateMediatedPayload(toolName, payload);
    return await this.options.mediatedTools.execute({
      toolName, toolCallId, payload, runDir: this.runDir,
      executionId: authorized.binding.executionId,
      operationId: authorized.binding.operationId,
      attemptId: authorized.binding.attemptId,
      outputRoot: authorized.outputRoot,
      workspace: authorized.binding.workspace,
      safety: this.database.readRun().safety,
      signal: authorized.abort.signal,
    });
  }

  private async bindingState(executionId: string): Promise<{ executionToken: string; outputRoot: string }> {
    const root = path.join(this.runDir, "sessions", executionId, "protocol");
    const file = path.join(root, "binding.json");
    const outputRoot = path.join(this.runDir, "outputs", executionId);
    await Promise.all([
      fs.promises.mkdir(root, { recursive: true, mode: 0o700 }),
      fs.promises.mkdir(outputRoot, { recursive: true, mode: 0o700 }),
    ]);
    try {
      const parsed = JSON.parse(await fs.promises.readFile(file, "utf8")) as { executionToken?: unknown; outputRoot?: unknown };
      if (typeof parsed.executionToken !== "string" || !/^[a-f0-9]{64}$/u.test(parsed.executionToken)
        || parsed.outputRoot !== outputRoot) throw new Error("Agent protocol binding file is corrupt");
      return { executionToken: parsed.executionToken, outputRoot };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const state = { executionToken: crypto.randomBytes(32).toString("hex"), outputRoot };
    await writeCanonicalExclusive(file, state);
    return state;
  }

  private receiptPath(executionId: string, toolCallId: string): string {
    return path.join(this.runDir, "sessions", executionId, "protocol", "receipts", `${stableHash(toolCallId).slice(7)}.json`);
  }

  private async readReceipt(executionId: string, toolCallId: string): Promise<DurableToolReceipt | undefined> {
    const file = this.receiptPath(executionId, toolCallId);
    try {
      const source = await fs.promises.readFile(file, "utf8");
      const value = JSON.parse(source) as DurableToolReceipt;
      if (source !== `${stableJson(value)}\n` || value.formatVersion !== 1
        || value.executionId !== executionId || value.toolCallId !== toolCallId) {
        throw new Error("Agent tool receipt is corrupt");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async receipts(executionId: string): Promise<DurableToolReceipt[]> {
    const directory = path.dirname(this.receiptPath(executionId, "receipt"));
    let names: string[];
    try { names = (await fs.promises.readdir(directory)).filter(name => name.endsWith(".json")).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const result: DurableToolReceipt[] = [];
    for (const name of names) {
      const source = await fs.promises.readFile(path.join(directory, name), "utf8");
      const value = JSON.parse(source) as DurableToolReceipt;
      if (source !== `${stableJson(value)}\n` || value.executionId !== executionId) throw new Error("Agent tool receipt set is corrupt");
      result.push(value);
    }
    return result;
  }

  private async writeReceipt(receipt: DurableToolReceipt): Promise<void> {
    const file = this.receiptPath(receipt.executionId, receipt.toolCallId);
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try { await writeCanonicalExclusive(file, receipt); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.readReceipt(receipt.executionId, receipt.toolCallId);
      if (stableJson(existing) !== stableJson(receipt)) throw new Error("Agent receipt publication collision");
    }
  }

  private send(socket: net.Socket, message: AgentProtocolServerMessage): void {
    socket.write(`${stableJson(message)}\n`);
  }
  private failure(socket: net.Socket, _requestId: string, error: unknown): void {
    this.send(socket, { type: "authenticated", protocolVersion: 1, ok: false, error: protocolErrorBody(error) });
    socket.end();
  }
  private responseFailure(socket: net.Socket, requestId: string, error: unknown): void {
    this.send(socket, { type: "response", protocolVersion: 1, requestId, ok: false, error: protocolErrorBody(error) });
  }
  private timestamp(): string {
    const value = (this.options.now ?? (() => new Date()))();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Agent protocol clock is invalid");
    return value.toISOString();
  }
}

function parseFinishResponse(value: JsonObject): AgentFinishRecord {
  const finish = record(value.finish, "finish receipt") as unknown as AgentFinishRecord;
  if (typeof finish.toolCallId !== "string" || typeof finish.schemaHash !== "string"
    || typeof finish.committedAt !== "string" || !Array.isArray(finish.artifacts)) {
    throw new Error("Agent finish receipt is invalid");
  }
  return structuredClone(finish);
}

function artifactRef(recordValue: WorkflowArtifactRecord) {
  return {
    digest: recordValue.digest,
    kind: recordValue.kind,
    mediaType: recordValue.mediaType,
    bytes: recordValue.bytes,
  };
}

function contained(rootInput: string, relative: string): string {
  if (!relative || relative.includes("\0") || path.isAbsolute(relative)) throw new TypeError("Published artifact path is invalid");
  const root = path.resolve(rootInput);
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new TypeError("Published artifact path escapes its output root");
  }
  return target;
}

function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, any>;
}

async function writeCanonicalExclusive(file: string, value: unknown): Promise<void> {
  const handle = await fs.promises.open(file, "wx", 0o600);
  try { await handle.writeFile(`${stableJson(value)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
