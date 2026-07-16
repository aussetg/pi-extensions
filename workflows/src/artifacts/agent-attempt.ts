import fs from "node:fs";
import path from "node:path";
import type { AgentEvent, AgentEventSink } from "../agents/executor.js";
import { executionIdentifier } from "../agents/sdk-protocol.js";
import { sha256 } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";

const MAX_EVENT_LINE_BYTES = 256 * 1024;
const MAX_EVENT_LOG_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_COUNT = 100_000;

export interface AgentEvidenceLogBinding {
  executionId: string;
  operationId: string;
  attemptId: string;
}

export interface FinalizedAgentEvidenceLog {
  path: string;
  digest: string;
  bytes: number;
  events: number;
}

/** Bounded evidence staging. Events never become completion authority here. */
export class AgentEvidenceLog implements AgentEventSink, AsyncDisposable {
  readonly runDir: string;
  readonly filePath: string;
  readonly binding: AgentEvidenceLogBinding;
  private sequence = 0;
  private bytes = 0;
  private initialized = false;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(runDirInput: string, binding: AgentEvidenceLogBinding) {
    this.binding = binding;
    this.runDir = path.resolve(runDirInput);
    executionIdentifier(binding.executionId);
    this.filePath = path.join(this.runDir, "outputs", binding.executionId, "events.jsonl");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const root = path.dirname(this.filePath);
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    await assertSafeDirectory(this.runDir, root);
    try {
      const stat = await fs.promises.lstat(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVENT_LOG_BYTES) {
        throw new Error("Agent evidence log is unsafe or oversized");
      }
      const body = await fs.promises.readFile(this.filePath);
      if (body.length && body.at(-1) !== 0x0a) throw new Error("Agent evidence log has an incomplete final line");
      const lines = body.toString("utf8").split("\n").filter(Boolean);
      if (lines.length > MAX_EVENT_COUNT) throw new Error("Agent evidence log exceeds its event bound");
      for (const [index, line] of lines.entries()) {
        const event = JSON.parse(line) as AgentEvent;
        if (
          event.executionId !== this.binding.executionId
          || event.operationId !== this.binding.operationId
          || event.attemptId !== this.binding.attemptId
          || event.sequence !== index + 1
        ) throw new Error("Agent evidence log has corrupt identity or order");
      }
      this.sequence = lines.length;
      this.bytes = body.length;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      const handle = await fs.promises.open(this.filePath, "wx", 0o600);
      try { await handle.sync(); } finally { await handle.close(); }
    }
    this.initialized = true;
  }

  async emit(event: AgentEvent): Promise<void> {
    if (!this.initialized || this.closed) throw new Error("Agent evidence log is not open");
    if (
      event.executionId !== this.binding.executionId
      || event.operationId !== this.binding.operationId
      || event.attemptId !== this.binding.attemptId
      || !Number.isSafeInteger(event.sequence)
      || event.sequence < 1
    ) throw new Error("Agent evidence event identity or sequence is invalid");
    // Physical workers restart their sequence at one. Evidence uses one
    // monotonic logical-session sequence across all recoveries.
    const normalized = { ...event, sequence: this.sequence + 1 } as AgentEvent;
    const line = `${stableJson(normalized)}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (lineBytes > MAX_EVENT_LINE_BYTES) throw new Error("Agent evidence event exceeds its line bound");
    if (this.sequence + 1 > MAX_EVENT_COUNT || this.bytes + lineBytes > MAX_EVENT_LOG_BYTES) {
      throw new Error("Agent evidence log exceeds its bound");
    }
    this.sequence += 1;
    this.bytes += lineBytes;
    this.chain = this.chain.then(() => fs.promises.appendFile(this.filePath, line, "utf8"));
    await this.chain;
  }

  async finalize(): Promise<FinalizedAgentEvidenceLog> {
    if (!this.initialized) throw new Error("Agent evidence log was not initialized");
    if (this.closed) throw new Error("Agent evidence log is already finalized");
    this.closed = true;
    await this.chain;
    const handle = await fs.promises.open(this.filePath, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    const body = await fs.promises.readFile(this.filePath);
    if (body.length !== this.bytes) throw new Error("Agent evidence log changed outside its writer");
    return {
      path: path.relative(this.runDir, this.filePath).split(path.sep).join("/"),
      digest: sha256(body),
      bytes: body.length,
      events: this.sequence,
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.closed && this.initialized) await this.finalize();
  }
}

export async function readAgentConversationTailPage(
  runDir: string,
  executionId: string,
  options: { limit?: number } = {},
): Promise<{ events: AgentEvent[]; cursor: number; previousCursor?: number }> {
  const page = await readEventLines(runDir, executionId);
  const selected = page.lines.slice(-boundedLimit(options.limit ?? 40));
  const cursor = selected[0]?.offset ?? page.body.length;
  return {
    events: selected.map((line) => parseEvent(line.text, executionId)),
    cursor,
    ...(cursor > 0 ? { previousCursor: 0 } : {}),
  };
}

async function readEventLines(runDirInput: string, executionId: string): Promise<{
  body: Buffer;
  lines: Array<{ offset: number; text: string }>;
}> {
  executionIdentifier(executionId);
  const runDir = path.resolve(runDirInput);
  const filePath = path.join(runDir, "outputs", executionId, "events.jsonl");
  const relative = path.relative(runDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Agent evidence path escapes its run");
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVENT_LOG_BYTES) throw new Error("Agent evidence log is unsafe or oversized");
  const body = await fs.promises.readFile(filePath);
  const lines: Array<{ offset: number; text: string }> = [];
  let start = 0;
  for (let index = 0; index < body.length; index++) {
    if (body[index] !== 0x0a) continue;
    if (index > start) lines.push({ offset: start, text: body.subarray(start, index).toString("utf8") });
    start = index + 1;
  }
  if (start !== body.length) throw new Error("Agent evidence log has an incomplete final line");
  return { body, lines };
}

function parseEvent(source: string, executionId: string): AgentEvent {
  const event = JSON.parse(source) as AgentEvent;
  if (event.executionId !== executionId || !Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    throw new Error("Agent evidence log contains an invalid event");
  }
  return event;
}

async function assertSafeDirectory(runDir: string, target: string): Promise<void> {
  const relative = path.relative(runDir, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Agent evidence directory escapes its run");
  let current = runDir;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.promises.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Agent evidence path contains an unsafe directory");
  }
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Invalid agent evidence page limit");
  return Math.min(value, 200);
}

