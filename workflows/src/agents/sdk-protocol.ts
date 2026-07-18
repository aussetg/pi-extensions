import net from "node:net";
import path from "node:path";
import type { JsonValue } from "../types.js";
import type { AgentProtocolToolName } from "../runtime/durable-types.js";
import type { AgentEvent } from "./executor.js";
import { stableJson, toStableJsonValue } from "../utils/stable-json.js";

export const AGENT_SDK_PROTOCOL_MAX_LINE_BYTES = 1024 * 1024;

export interface AgentProtocolErrorBody {
  code: string;
  message: string;
  retryable: boolean;
}

export type AgentProtocolClientMessage =
  | {
      type: "authenticate";
      executionId: string;
      executionToken: string;
    }
  | {
      type: "tool-request";
      requestId: string;
      toolCallId: string;
      toolName: AgentProtocolToolName;
      payload: JsonValue;
    }
  | {
      type: "agent-event";
      requestId: string;
      event: JsonValue;
    };

export type AgentProtocolServerMessage =
  | { type: "authenticated"; ok: true }
  | { type: "authenticated"; ok: false; error: AgentProtocolErrorBody }
  | { type: "response"; requestId: string; ok: true; result: JsonValue }
  | { type: "response"; requestId: string; ok: false; error: AgentProtocolErrorBody };

export interface AgentWorkerProtocol extends AsyncDisposable {
  request(toolName: AgentProtocolToolName, toolCallId: string, payload: JsonValue): Promise<JsonValue>;
  emit(event: AgentEvent): Promise<void>;
  close(): Promise<void>;
}

export class AgentProtocolError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(body: AgentProtocolErrorBody) {
    super(body.message);
    this.name = "AgentProtocolError";
    this.code = body.code;
    this.retryable = body.retryable;
  }
}

export function agentProtocolSocketPath(runDirInput: string): string {
  const socketPath = path.join(path.resolve(runDirInput), "agent-protocol.sock");
  if (Buffer.byteLength(socketPath) > 103) {
    throw new Error("Workflow run path is too long for its private agent Unix socket");
  }
  return socketPath;
}

export function parseAgentProtocolClientMessage(value: unknown): AgentProtocolClientMessage {
  const message = record(value, "agent protocol message");
  if (message.type === "authenticate") {
    exactKeys(message, ["type", "executionId", "executionToken"]);
    const executionId = executionIdentifier(message.executionId);
    if (typeof message.executionToken !== "string" || !/^[a-f0-9]{64}$/.test(message.executionToken)) {
      throw protocolFailure("authentication", "Invalid agent execution token");
    }
    return { type: "authenticate", executionId, executionToken: message.executionToken };
  }
  if (message.type === "tool-request") {
    exactKeys(message, ["type", "requestId", "toolCallId", "toolName", "payload"]);
    const toolName = message.toolName;
    if (![
      "finish_work", "report_progress", "log_result", "publish_artifact",
      "web_search", "web_fetch", "workspace_command",
    ].includes(String(toolName))) {
      throw protocolFailure("unknown-tool", `Unknown agent terminal tool ${String(toolName)}`);
    }
    return {
      type: "tool-request",
      requestId: wireIdentifier(message.requestId, "request"),
      toolCallId: wireIdentifier(message.toolCallId, "tool call", 256),
      toolName: toolName as AgentProtocolToolName,
      payload: jsonValue(message.payload),
    };
  }
  if (message.type === "agent-event") {
    exactKeys(message, ["type", "requestId", "event"]);
    return {
      type: "agent-event",
      requestId: wireIdentifier(message.requestId, "request"),
      event: jsonValue(message.event),
    };
  }
  throw protocolFailure("unknown-message", `Unknown agent protocol message ${String(message.type)}`);
}

export function parseAgentProtocolServerMessage(value: unknown): AgentProtocolServerMessage {
  const message = record(value, "agent protocol response");
  if (message.type === "authenticated") {
    if (message.ok === true) {
      exactKeys(message, ["type", "ok"]);
      return { type: "authenticated", ok: true };
    }
    exactKeys(message, ["type", "ok", "error"]);
    return { type: "authenticated", ok: false, error: errorBody(message.error) };
  }
  if (message.type === "response") {
    const requestId = wireIdentifier(message.requestId, "request");
    if (message.ok === true) {
      exactKeys(message, ["type", "requestId", "ok", "result"]);
      return { type: "response", requestId, ok: true, result: jsonValue(message.result) };
    }
    exactKeys(message, ["type", "requestId", "ok", "error"]);
    return { type: "response", requestId, ok: false, error: errorBody(message.error) };
  }
  throw protocolFailure("unknown-message", `Unknown agent protocol response ${String(message.type)}`);
}

export class AgentProtocolClient implements AgentWorkerProtocol {
  private readonly pending = new Map<string, { resolve(value: JsonValue): void; reject(error: unknown): void }>();
  private requestSequence = 0;
  private buffer = "";
  private closed = false;
  private readonly socket: net.Socket;

  private constructor(socket: net.Socket) { this.socket = socket; }

  static async connect(options: {
    socketPath: string;
    executionId: string;
    executionToken: string;
  }): Promise<AgentProtocolClient> {
    executionIdentifier(options.executionId);
    if (!/^[a-f0-9]{64}$/.test(options.executionToken)) throw new TypeError("Invalid agent execution token");
    const socket = net.createConnection({ path: path.resolve(options.socketPath) });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = new AgentProtocolClient(socket);
    client.attach();
    const authenticated = new Promise<void>((resolve, reject) => {
      const onMessage = (message: AgentProtocolServerMessage) => {
        if (message.type !== "authenticated") return;
        client.authenticationListener = undefined;
        client.authenticationReject = undefined;
        message.ok ? resolve() : reject(new AgentProtocolError(message.error));
      };
      client.authenticationListener = onMessage;
      client.authenticationReject = reject;
    });
    client.write({
      type: "authenticate",
      executionId: options.executionId,
      executionToken: options.executionToken,
    });
    try {
      await authenticated;
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  private authenticationListener?: (message: AgentProtocolServerMessage) => void;
  private authenticationReject?: (error: unknown) => void;

  async request(toolName: AgentProtocolToolName, toolCallId: string, payload: JsonValue): Promise<JsonValue> {
    wireIdentifier(toolCallId, "tool call", 256);
    return await this.roundTrip({
      type: "tool-request",
      requestId: this.nextRequestId(),
      toolCallId,
      toolName,
      payload: jsonValue(payload),
    });
  }

  async emit(event: AgentEvent): Promise<void> {
    await this.roundTrip({
      type: "agent-event",
      requestId: this.nextRequestId(),
      event: jsonValue(event),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
    if (!this.socket.destroyed) {
      await new Promise<void>((resolve) => {
        this.socket.once("close", resolve);
        const timer = setTimeout(() => { this.socket.destroy(); resolve(); }, 250);
        timer.unref?.();
      });
    }
    this.rejectAll(protocolFailure("connection-closed", "Agent protocol connection closed", true));
  }

  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }

  private attach(): void {
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.consume(chunk));
    this.socket.on("error", (error) => {
      this.authenticationReject?.(error);
      this.rejectAll(error);
    });
    this.socket.on("close", () => {
      const error = protocolFailure("connection-closed", "Agent protocol connection closed", true);
      this.authenticationReject?.(error);
      this.rejectAll(error);
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > AGENT_SDK_PROTOCOL_MAX_LINE_BYTES) {
      this.socket.destroy(protocolFailure("line-too-large", "Agent protocol response exceeded its bound"));
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: AgentProtocolServerMessage;
      try { message = parseAgentProtocolServerMessage(JSON.parse(line)); }
      catch (error) { this.socket.destroy(error as Error); return; }
      if (this.authenticationListener) {
        this.authenticationListener(message);
        if (message.type === "authenticated") continue;
      }
      if (message.type !== "response") {
        this.socket.destroy(protocolFailure("unexpected-response", "Unexpected agent authentication response"));
        return;
      }
      const pending = this.pending.get(message.requestId);
      if (!pending) {
        this.socket.destroy(protocolFailure("unexpected-response", `Unknown agent response ${message.requestId}`));
        return;
      }
      this.pending.delete(message.requestId);
      message.ok ? pending.resolve(message.result) : pending.reject(new AgentProtocolError(message.error));
    }
  }

  private async roundTrip(message: Exclude<AgentProtocolClientMessage, { type: "authenticate" }>): Promise<JsonValue> {
    if (this.closed) throw protocolFailure("connection-closed", "Agent protocol connection is closed", true);
    const result = new Promise<JsonValue>((resolve, reject) => this.pending.set(message.requestId, { resolve, reject }));
    try { this.write(message); }
    catch (error) { this.pending.delete(message.requestId); throw error; }
    return await result;
  }

  private write(message: AgentProtocolClientMessage): void {
    const line = `${stableJson(message)}\n`;
    if (Buffer.byteLength(line) > AGENT_SDK_PROTOCOL_MAX_LINE_BYTES) throw protocolFailure("line-too-large", "Agent protocol request exceeded its bound");
    this.socket.write(line);
  }

  private nextRequestId(): string {
    this.requestSequence += 1;
    return `request-${this.requestSequence}`;
  }

  private rejectAll(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function protocolErrorBody(error: unknown): AgentProtocolErrorBody {
  if (error instanceof AgentProtocolError) {
    return { code: error.code, message: boundedError(error.message), retryable: error.retryable };
  }
  return {
    code: "request-rejected",
    message: boundedError(error instanceof Error ? error.message : String(error)),
    retryable: false,
  };
}

export function protocolFailure(code: string, message: string, retryable = false): AgentProtocolError {
  return new AgentProtocolError({ code, message, retryable });
}

export function executionIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@+~-]{0,127}$/.test(value)) {
    throw protocolFailure("invalid-identity", "Invalid agent execution id");
  }
  return value;
}

function wireIdentifier(value: unknown, label: string, maximum = 128): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw protocolFailure("invalid-identity", `Invalid agent ${label} id`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw protocolFailure("malformed-message", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw protocolFailure("malformed-message", "Agent protocol message contains unexpected fields");
  }
}

function jsonValue(value: unknown): JsonValue {
  try { return toStableJsonValue(value); }
  catch (error) { throw protocolFailure("malformed-json", error instanceof Error ? error.message : String(error)); }
}

function errorBody(value: unknown): AgentProtocolErrorBody {
  const body = record(value, "agent protocol error");
  exactKeys(body, ["code", "message", "retryable"]);
  if (typeof body.code !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(body.code)) throw protocolFailure("malformed-message", "Invalid agent protocol error code");
  if (typeof body.message !== "string" || Buffer.byteLength(body.message) > 4_000 || typeof body.retryable !== "boolean") {
    throw protocolFailure("malformed-message", "Invalid agent protocol error body");
  }
  return { code: body.code, message: body.message, retryable: body.retryable };
}

function boundedError(value: string): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, 2_000).join("") || "Agent protocol request failed";
}
