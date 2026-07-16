import fs from "node:fs";
import path from "node:path";
import type { AgentMediatedToolName } from "../runtime/durable-types.js";
import type { JsonValue } from "../types.js";

export interface AgentProtocolWorkspaceAuthority {
  mode: "read-only" | "candidate";
  root: string;
  cwd: string;
}

export interface AgentMediatedToolRequest {
  toolName: AgentMediatedToolName;
  toolCallId: string;
  payload: JsonValue;
  runDir: string;
  executionId: string;
  operationId: string;
  attemptId: string;
  outputRoot: string;
  workspace: AgentProtocolWorkspaceAuthority;
  signal: AbortSignal;
}

export interface AgentMediatedToolCancellation {
  toolName: AgentMediatedToolName;
  toolCallId: string;
  runDir: string;
  executionId: string;
  operationId: string;
  attemptId: string;
}

export interface AgentMediatedToolExecutor {
  execute(request: AgentMediatedToolRequest): Promise<JsonValue>;
  cancel(request: AgentMediatedToolCancellation): Promise<void>;
}

export async function assertMediatedWorkspace(workspace: AgentProtocolWorkspaceAuthority): Promise<void> {
  if (workspace.mode !== "read-only" && workspace.mode !== "candidate") throw new TypeError("Invalid mediated workspace mode");
  if (!path.isAbsolute(workspace.root) || !path.isAbsolute(workspace.cwd)) throw new TypeError("Mediated workspace paths must be absolute");
  const [root, cwd] = await Promise.all([
    fs.promises.realpath(workspace.root),
    fs.promises.realpath(workspace.cwd),
  ]);
  if (root !== path.resolve(workspace.root)) throw new Error("Mediated workspace root traverses a symbolic link");
  const relative = path.relative(root, cwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Mediated workspace cwd escapes its root");
  }
}

export function validateMediatedPayload(toolName: AgentMediatedToolName, value: JsonValue): void {
  if (toolName === "workspace_command") {
    const payload = exactObject(value, ["argv", "timeoutMs"], toolName, true);
    if (!Array.isArray(payload.argv) || payload.argv.length < 1 || payload.argv.length > 256) {
      throw new TypeError("workspace_command argv is invalid");
    }
    for (const [index, argument] of payload.argv.entries()) {
      if (typeof argument !== "string" || !argument || argument.includes("\0") || Buffer.byteLength(argument) > 16_384) {
        throw new TypeError(`workspace_command argv[${index}] is invalid`);
      }
    }
    if (payload.timeoutMs !== undefined
      && (!Number.isSafeInteger(payload.timeoutMs) || (payload.timeoutMs as number) < 1 || (payload.timeoutMs as number) > 120_000)) {
      throw new TypeError("workspace_command timeout is invalid");
    }
    return;
  }
  if (toolName === "web_search") {
    const payload = exactObject(value, ["query", "maxResults"], toolName, true);
    boundedText(payload.query, "web search query", 4_096);
    if (payload.maxResults !== undefined
      && (!Number.isSafeInteger(payload.maxResults) || (payload.maxResults as number) < 1 || (payload.maxResults as number) > 20)) {
      throw new TypeError("web_search maxResults is invalid");
    }
    return;
  }
  const payload = exactObject(value, ["url", "maxBytes"], toolName, true);
  const url = boundedText(payload.url, "web fetch URL", 8_192);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new TypeError("web_fetch URL is invalid"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new TypeError("web_fetch requires an unauthenticated HTTPS URL");
  if (payload.maxBytes !== undefined
    && (!Number.isSafeInteger(payload.maxBytes) || (payload.maxBytes as number) < 1_024 || (payload.maxBytes as number) > 2 * 1024 * 1024)) {
    throw new TypeError("web_fetch maxBytes is invalid");
  }
}

function exactObject(
  value: unknown,
  keys: string[],
  label: string,
  optional = false,
): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} payload must be an object`);
  const object = value as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(object)) if (!allowed.has(key)) throw new TypeError(`${label} payload contains unknown field ${key}`);
  if (!optional) for (const key of keys) if (!Object.hasOwn(object, key)) throw new TypeError(`${label} payload is missing ${key}`);
  return object;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}
