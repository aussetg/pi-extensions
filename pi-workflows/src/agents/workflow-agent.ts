import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AgentOptions, JsonSchema, WorkflowUsage } from "../types.js";
import type { ThinkingLevel } from "../thinking.js";
import { WORKFLOW_RESOURCE_LIMITS } from "../constants.js";
import { BoundedTextAccumulator, byteLength, truncateBytes } from "../utils/truncate.js";
import { ensureDir } from "../persistence/paths.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";
import { WorkflowAbortError, WorkflowSkipAgentError } from "../runtime/errors.js";

interface MessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface MessageLike {
  role: string;
  content?: MessagePart[] | string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
  stopReason?: string;
  errorMessage?: string;
  model?: string;
}

interface SubagentStreamState {
  stdoutBytes: number;
  eventCount: number;
  parsedEventCount: number;
  malformedEventCount: number;
  droppedOversizeLines: number;
  messageCount: number;
  assistantMessageCount: number;
  toolExecutions: number;
  fallbackToolCalls: number;
  subagentTokens: number;
  resultText: string;
  model?: string;
  sessionId?: string;
  sessionCwd?: string;
  sessionTimestamp?: string;
}

export interface WorkflowAgentCall {
  callId: string;
  runId: string;
  cwd: string;
  phase?: string;
  label: string;
  prompt: string;
  options: AgentOptions;
  transcriptDir: string;
  activeTools?: string[];
  signal: AbortSignal;
  stallMs: number;
  stallRetries: number;
}

export interface WorkflowAgentResult {
  result: unknown;
  resultText: string;
  transcriptPath: string;
  resultPath: string;
  usage: WorkflowUsage;
  model?: string;
  thinking?: ThinkingLevel;
  sessionPath?: string;
  workspace?: AgentWorkspaceArtifacts;
}

interface AgentWorkspace {
  cwd: string;
  cleanupLabel?: string;
  artifacts?: AgentWorkspaceArtifacts;
  collect(): Promise<AgentWorkspaceArtifacts | undefined>;
  cleanup(): Promise<void>;
}

interface AgentWorkspaceArtifacts {
  kind: "worktree";
  worktreeDir: string;
  statusPath?: string;
  patchPath?: string;
  ignoredManifestPath?: string;
  ignoredFilesDir?: string;
  error?: string;
}

interface IgnoredArtifactManifest {
  version: 1;
  kind: "worktree_ignored_files";
  limits: {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
  };
  totalBytes: number;
  files: Array<
    | { path: string; type: "file"; bytes: number; artifactPath: string }
    | { path: string; type: "symlink"; bytes: number; target: string }
  >;
  omitted: Array<{ path: string; reason: string; bytes?: number }>;
}

export class WorkflowAgent {
  async run(call: WorkflowAgentCall): Promise<WorkflowAgentResult> {
    const callDir = path.join(call.transcriptDir, call.callId);
    await ensureDir(callDir);
    const promptPath = path.join(callDir, "prompt.txt");
    await fs.promises.writeFile(promptPath, call.prompt, "utf8");

    let lastError: unknown;
    for (let attempt = 0; attempt <= call.stallRetries; attempt++) {
      try {
        return await this.runAttempt(call, callDir, attempt);
      } catch (err) {
        if (err instanceof WorkflowSkipAgentError || err instanceof WorkflowAbortError || call.signal.aborted) throw err;
        lastError = err;
        if (!String((err as Error).message).includes("stalled") || attempt >= call.stallRetries) break;
      }
    }
    const errorPath = path.join(callDir, "error.json");
    await fs.promises.writeFile(errorPath, `${JSON.stringify({ error: String((lastError as Error)?.message ?? lastError) }, null, 2)}\n`, "utf8");
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async runAttempt(call: WorkflowAgentCall, callDir: string, attempt: number): Promise<WorkflowAgentResult> {
    const stream = createSubagentStreamState();
    const stderr = new BoundedTextAccumulator(WORKFLOW_RESOURCE_LIMITS.subagentStderrBytes, "\n… subagent stderr truncated …");
    const workspace = await prepareAgentWorkspace(call, callDir, attempt);
    const sessionDir = path.join(callDir, attempt === 0 ? "pi-session" : `pi-session-attempt-${attempt}`);
    await fs.promises.rm(sessionDir, { recursive: true, force: true });
    await ensureDir(sessionDir);

    const args = ["--mode", "json", "-p", "--session-dir", sessionDir];
    if (call.options.model) args.push("--model", call.options.model);
    if (call.options.thinking) args.push("--thinking", call.options.thinking);
    args.push(...subagentToolArgs(call.activeTools));

    const systemPrompt = buildSubagentSystemPrompt(call);
    const tmp = await writeTempPrompt(call.callId, systemPrompt);
    args.push("--append-system-prompt", tmp.filePath);
    args.push(call.prompt);

    let completedResult: WorkflowAgentResult | undefined;
    let primaryError: unknown;
    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        const invocation = getPiInvocation(args);
        const proc = spawn(invocation.command, invocation.args, { cwd: workspace.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        const stdoutDecoder = new StringDecoder("utf8");
        let stdoutBuffer = "";
        let discardingOversizeLine = false;
        let stalled = false;
        let timer: NodeJS.Timeout | undefined;
        let settled = false;

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          call.signal.removeEventListener("abort", abort);
        };

        const fail = (err: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          proc.kill("SIGTERM");
          setTimeout(() => proc.kill("SIGKILL"), 3_000).unref?.();
          reject(err);
        };

        const resetTimer = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            stalled = true;
            proc.kill("SIGTERM");
            setTimeout(() => proc.kill("SIGKILL"), 3_000).unref?.();
          }, call.options.stallMs ?? call.stallMs);
          timer.unref?.();
        };
        resetTimer();

        const abort = () => {
          fail(call.signal.reason ?? new WorkflowAbortError());
        };
        if (call.signal.aborted) return abort();
        call.signal.addEventListener("abort", abort, { once: true });

        const processLine = (line: string) => {
          if (!line.trim()) return;
          if (byteLength(line) > WORKFLOW_RESOURCE_LIMITS.subagentStdoutLineBytes) {
            if (isDroppableOversizedEventPrefix(line)) {
              stream.eventCount++;
              stream.droppedOversizeLines++;
              resetTimer();
              return;
            }
            throw new Error(`Subagent ${call.callId} stdout line exceeded ${WORKFLOW_RESOURCE_LIMITS.subagentStdoutLineBytes} bytes`);
          }
          resetTimer();
          stream.eventCount++;
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            stream.malformedEventCount++;
            return;
          }
          stream.parsedEventCount++;
          recordSubagentEvent(call.callId, event, stream);
        };

        proc.stdout.on("data", (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
          stream.stdoutBytes += buffer.length;
          try {
            stdoutBuffer += stdoutDecoder.write(buffer);
            while (true) {
              const newline = stdoutBuffer.indexOf("\n");
              if (discardingOversizeLine) {
                if (newline === -1) {
                  stdoutBuffer = "";
                  return;
                }
                stdoutBuffer = stdoutBuffer.slice(newline + 1);
                discardingOversizeLine = false;
                continue;
              }
              if (newline === -1) {
                if (byteLength(stdoutBuffer) > WORKFLOW_RESOURCE_LIMITS.subagentStdoutLineBytes) {
                  if (isDroppableOversizedEventPrefix(stdoutBuffer)) {
                    stream.eventCount++;
                    stream.droppedOversizeLines++;
                    discardingOversizeLine = true;
                    stdoutBuffer = "";
                    resetTimer();
                    return;
                  }
                  throw new Error(`Subagent ${call.callId} stdout line exceeded ${WORKFLOW_RESOURCE_LIMITS.subagentStdoutLineBytes} bytes`);
                }
                return;
              }
              const line = stdoutBuffer.slice(0, newline);
              stdoutBuffer = stdoutBuffer.slice(newline + 1);
              processLine(line);
            }
          } catch (err) {
            fail(err);
          }
        });
        proc.stderr.on("data", (chunk) => stderr.append(chunk.toString("utf8")));
        proc.on("error", fail);
        proc.on("close", (code) => {
          if (settled) return;
          settled = true;
          cleanup();
          try {
            stdoutBuffer += stdoutDecoder.end();
            if (!discardingOversizeLine && stdoutBuffer.trim()) processLine(stdoutBuffer);
          } catch (err) {
            reject(err);
            return;
          }
          if (stalled) reject(new Error(`Subagent ${call.callId} stalled after ${call.stallMs}ms`));
          else resolve(code ?? 0);
        });
      });

      const workspaceArtifacts = await workspace.collect();
      const sessionPath = await findPiSessionPath(sessionDir, stream.sessionId);

      const transcriptPath = path.join(callDir, attempt === 0 ? "transcript.json" : `transcript-attempt-${attempt}.json`);
      await fs.promises.writeFile(transcriptPath, `${JSON.stringify(buildTranscriptSummary({ attempt, exitCode, stderr: stderr.toString(), sessionDir, sessionPath, stream, workspace: workspaceArtifacts }), null, 2)}\n`, "utf8");
      if (exitCode !== 0) throw new Error(`Subagent ${call.callId} exited with ${exitCode}: ${truncateBytes(stderr.toString(), 4000)}`);

      const resultText = stream.resultText;
      assertResultTextWithinLimit(call.callId, resultText);
      const result = call.options.schema ? parseStructuredResult(resultText, call.options.schema) : resultText;
      const usage = collectUsage(stream);
      const resultPath = path.join(callDir, "result.json");
      completedResult = { result, resultText, transcriptPath, resultPath, usage, model: stream.model, thinking: call.options.thinking, sessionPath, workspace: workspaceArtifacts };
      await writeWorkflowAgentResult(completedResult);
      return completedResult;
    } catch (err) {
      primaryError = err;
      throw err;
    } finally {
      const cleanupErrors = await cleanupAttempt(tmp.dir, workspace);
      if (cleanupErrors.length > 0) {
        if (completedResult) {
          await recordSuccessfulCleanupErrors(completedResult, cleanupErrors);
        } else if (primaryError === undefined) {
          throw new Error(cleanupErrors.join("; "));
        }
      }
    }
  }
}

async function cleanupAttempt(tmpDir: string, workspace: AgentWorkspace): Promise<string[]> {
  const errors: string[] = [];
  try {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  } catch (err) {
    errors.push(`temporary prompt cleanup failed: ${(err as Error).message}`);
  }

  try {
    await workspace.cleanup();
  } catch (err) {
    errors.push(`${workspace.cleanupLabel ?? "workspace"} cleanup failed: ${(err as Error).message}`);
  }
  return errors;
}

async function recordSuccessfulCleanupErrors(result: WorkflowAgentResult, cleanupErrors: string[]): Promise<void> {
  if (!result.workspace) return;
  result.workspace.error = appendArtifactError(result.workspace.error, cleanupErrors.join("; "));
  await Promise.all([
    writeWorkflowAgentResult(result).catch(() => undefined),
    rewriteTranscriptWorkspace(result.transcriptPath, result.workspace).catch(() => undefined),
  ]);
}

function appendArtifactError(existing: string | undefined, message: string): string {
  return existing ? `${existing}; ${message}` : message;
}

async function writeWorkflowAgentResult(result: WorkflowAgentResult): Promise<void> {
  await fs.promises.writeFile(
    result.resultPath,
    `${JSON.stringify({ status: "done", result: result.result, resultText: result.resultText, usage: result.usage, model: result.model, thinking: result.thinking, sessionPath: result.sessionPath, workspace: result.workspace }, null, 2)}\n`,
    "utf8",
  );
}

async function rewriteTranscriptWorkspace(transcriptPath: string, workspace: AgentWorkspaceArtifacts): Promise<void> {
  const value = JSON.parse(await readBoundedTextFile(transcriptPath, WORKFLOW_RESOURCE_LIMITS.workflowOutputBytes)) as Record<string, unknown>;
  value.workspace = workspace;
  await fs.promises.writeFile(transcriptPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildSubagentSystemPrompt(call: WorkflowAgentCall): string {
  const schemaText = call.options.schema
    ? `\nIf a JSON schema is provided below, return ONLY a JSON value conforming to it, with no Markdown fences.\nSchema:\n${JSON.stringify(call.options.schema, null, 2)}\n`
    : "";
  const isolationText = call.options.isolation === "worktree"
    ? "\nIsolation: you are running with cwd inside a disposable git worktree. Keep all file edits inside that worktree; in-worktree edits are captured as patch artifacts, and ignored outputs are captured separately as bounded artifacts. Nothing is applied to the user's main working tree automatically. Writes outside the worktree are not captured.\n"
    : "";
  return `You are a workflow subagent.\nWorkflow: ${call.runId}\nPhase: ${call.phase ?? "(none)"}\nTask label: ${call.label}\n${isolationText}\nWork independently. Do not ask the user questions. Use tools as needed. Return only the requested result.${schemaText}`;
}

function subagentToolArgs(activeTools: readonly string[] | undefined): string[] {
  const tools = normalizeSubagentTools(activeTools);
  return tools.length > 0 ? ["--tools", tools.join(",")] : ["--no-tools"];
}

function normalizeSubagentTools(activeTools: readonly string[] | undefined): string[] {
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const raw of activeTools ?? []) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (!name || name === "workflow" || name.includes(",")) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    tools.push(name);
  }
  return tools;
}

function createSubagentStreamState(): SubagentStreamState {
  return {
    stdoutBytes: 0,
    eventCount: 0,
    parsedEventCount: 0,
    malformedEventCount: 0,
    droppedOversizeLines: 0,
    messageCount: 0,
    assistantMessageCount: 0,
    toolExecutions: 0,
    fallbackToolCalls: 0,
    subagentTokens: 0,
    resultText: "",
  };
}

function recordSubagentEvent(callId: string, event: unknown, stream: SubagentStreamState): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  const record = event as Record<string, unknown>;
  if (record.type === "session") {
    if (typeof record.id === "string" && record.id.trim()) stream.sessionId = record.id;
    if (typeof record.cwd === "string" && record.cwd.trim()) stream.sessionCwd = record.cwd;
    if (typeof record.timestamp === "string" && record.timestamp.trim()) stream.sessionTimestamp = record.timestamp;
    return;
  }

  if (record.type === "tool_execution_start") {
    stream.toolExecutions++;
    return;
  }

  if ((record.type !== "message_end" && record.type !== "tool_result_end") || !isMessageLike(record.message)) return;

  stream.messageCount++;
  const message = record.message;
  if (message.role !== "assistant") return;

  stream.assistantMessageCount++;
  stream.subagentTokens += message.usage?.totalTokens ?? (message.usage?.input ?? 0) + (message.usage?.output ?? 0);
  stream.fallbackToolCalls += countToolCallParts(message);

  if (typeof message.model === "string" && message.model.trim()) stream.model = message.model;
  const text = assistantTextFromMessage(callId, message);
  if (typeof message.content === "string" || text.trim()) stream.resultText = text;
}

function isMessageLike(value: unknown): value is MessageLike {
  return !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as MessageLike).role === "string";
}

function assistantTextFromMessage(callId: string, message: MessageLike): string {
  if (typeof message.content === "string") {
    assertResultTextWithinLimit(callId, message.content);
    return message.content;
  }
  if (!Array.isArray(message.content)) return "";
  const chunks: string[] = [];
  let bytes = 0;
  for (const part of message.content) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    bytes += byteLength(part.text) + (chunks.length > 0 ? 1 : 0);
    if (bytes > WORKFLOW_RESOURCE_LIMITS.subagentResultTextBytes) {
      throw new Error(`Subagent ${callId} final result exceeded ${WORKFLOW_RESOURCE_LIMITS.subagentResultTextBytes} bytes`);
    }
    chunks.push(part.text);
  }
  return chunks.join("\n");
}

function countToolCallParts(message: MessageLike): number {
  return Array.isArray(message.content) ? message.content.filter((part) => part.type === "toolCall").length : 0;
}

function collectUsage(stream: SubagentStreamState): WorkflowUsage {
  return {
    agentCount: 1,
    subagentTokens: stream.subagentTokens,
    toolUses: stream.toolExecutions > 0 ? stream.toolExecutions : stream.fallbackToolCalls,
    estimated: false,
  };
}

function assertResultTextWithinLimit(callId: string, resultText: string): void {
  const bytes = byteLength(resultText);
  if (bytes > WORKFLOW_RESOURCE_LIMITS.subagentResultTextBytes) {
    throw new Error(`Subagent ${callId} final result exceeded ${WORKFLOW_RESOURCE_LIMITS.subagentResultTextBytes} bytes`);
  }
}

function isDroppableOversizedEventPrefix(line: string): boolean {
  return /^\s*\{\s*"type"\s*:\s*"(?:agent_end|turn_end|message_update|tool_execution_update|tool_execution_end|queue_update|compaction_end)"/.test(line);
}

function buildTranscriptSummary(input: { attempt: number; exitCode: number; stderr: string; sessionDir: string; sessionPath?: string; stream: SubagentStreamState; workspace?: AgentWorkspaceArtifacts }): Record<string, unknown> {
  return {
    attempt: input.attempt,
    exitCode: input.exitCode,
    stderr: input.stderr,
    piSession: {
      sessionDir: input.sessionDir,
      sessionPath: input.sessionPath,
      sessionId: input.stream.sessionId,
      cwd: input.stream.sessionCwd,
      timestamp: input.stream.sessionTimestamp,
    },
    stream: {
      stdoutBytes: input.stream.stdoutBytes,
      eventCount: input.stream.eventCount,
      parsedEventCount: input.stream.parsedEventCount,
      malformedEventCount: input.stream.malformedEventCount,
      droppedOversizeLines: input.stream.droppedOversizeLines,
      messageCount: input.stream.messageCount,
      assistantMessageCount: input.stream.assistantMessageCount,
      toolExecutions: input.stream.toolExecutions,
      fallbackToolCalls: input.stream.fallbackToolCalls,
      subagentTokens: input.stream.subagentTokens,
      messagesRetained: false,
    },
    workspace: input.workspace,
  };
}

async function findPiSessionPath(sessionDir: string, sessionId?: string): Promise<string | undefined> {
  const files: Array<{ filePath: string; mtimeMs: number }> = [];
  await collectSessionFiles(sessionDir, files, 0, { entries: 0 });
  if (files.length === 0) return undefined;

  if (sessionId) {
    const filenameMatch = newestSession(files.filter((file) => path.basename(file.filePath).includes(sessionId)));
    if (filenameMatch) return filenameMatch.filePath;

    for (const file of files) {
      if (await sessionHeaderMatches(file.filePath, sessionId)) return file.filePath;
    }
  }

  return newestSession(files)?.filePath;
}

async function collectSessionFiles(dir: string, files: Array<{ filePath: string; mtimeMs: number }>, depth: number, state: { entries: number }): Promise<void> {
  if (depth > 8 || state.entries > 2_000) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (++state.entries > 2_000) return;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSessionFiles(fullPath, files, depth + 1, state);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const stat = await fs.promises.stat(fullPath).catch(() => undefined);
      files.push({ filePath: fullPath, mtimeMs: stat?.mtimeMs ?? 0 });
    }
  }
}

function newestSession(files: Array<{ filePath: string; mtimeMs: number }>): { filePath: string; mtimeMs: number } | undefined {
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
}

async function sessionHeaderMatches(filePath: string, sessionId: string): Promise<boolean> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(filePath, "r");
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0]?.trim();
    if (!firstLine) return false;
    const header = JSON.parse(firstLine) as Record<string, unknown>;
    return header.type === "session" && header.id === sessionId;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseStructuredResult(text: string, schema: JsonSchema): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Subagent structured output was not valid JSON: ${(err as Error).message}. Output: ${truncateBytes(text, 2000)}`);
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`Subagent structured output failed schema: ${ajv.errorsText(validate.errors)}`);
  return value;
}

async function writeTempPrompt(callId: string, text: string): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-agent-"));
  const filePath = path.join(dir, `${callId}.md`);
  await fs.promises.writeFile(filePath, text, { encoding: "utf8", mode: 0o600 });
  return { dir, filePath };
}

async function prepareAgentWorkspace(call: WorkflowAgentCall, callDir: string, attempt: number): Promise<AgentWorkspace> {
  if (call.options.isolation !== "worktree") {
    return { cwd: call.cwd, collect: async () => undefined, cleanup: async () => undefined };
  }

  const git = await getGitWorkspace(call.cwd).catch((err) => {
    throw new Error(`isolation: "worktree" requires a git worktree cwd: ${(err as Error).message}`);
  });
  const worktreeDir = path.join(callDir, attempt === 0 ? "worktree" : `worktree-attempt-${attempt}`);
  const statusPath = path.join(callDir, attempt === 0 ? "worktree-status.txt" : `worktree-status-attempt-${attempt}.txt`);
  const patchPath = path.join(callDir, attempt === 0 ? "worktree.patch" : `worktree-attempt-${attempt}.patch`);
  const ignoredManifestPath = path.join(callDir, attempt === 0 ? "worktree-ignored.json" : `worktree-ignored-attempt-${attempt}.json`);
  const ignoredFilesDir = path.join(callDir, attempt === 0 ? "worktree-ignored" : `worktree-ignored-attempt-${attempt}`);

  await fs.promises.rm(worktreeDir, { recursive: true, force: true });
  await ensureDir(path.dirname(worktreeDir));
  await gitExec(["-C", git.root, "worktree", "add", "--detach", worktreeDir, "HEAD"]);

  try {
    await mirrorDirtyState(git.root, worktreeDir);
    await gitExec(["-C", worktreeDir, "add", "-A"]);
    await gitExec([
      "-C",
      worktreeDir,
      "-c",
      "user.name=pi-workflows",
      "-c",
      "user.email=pi-workflows@local",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "pi workflow isolation baseline",
    ]);
  } catch (err) {
    await removeGitWorktree(git.root, worktreeDir);
    throw err;
  }

  return {
    cwd: path.join(worktreeDir, git.prefix),
    cleanupLabel: "worktree",
    async collect() {
      const artifacts: AgentWorkspaceArtifacts = { kind: "worktree", worktreeDir, statusPath, patchPath, ignoredManifestPath, ignoredFilesDir };
      const errors: string[] = [];

      try {
        const status = await gitExec(["-C", worktreeDir, "status", "--short", "--ignored", "--untracked-files=all"], { allowFailure: true });
        await fs.promises.writeFile(statusPath, status.stdout || status.stderr || "", "utf8");
      } catch (err) {
        delete artifacts.statusPath;
        errors.push(`worktree status capture failed: ${(err as Error).message}`);
      }

      try {
        await gitExec(["-C", worktreeDir, "add", "-A"]);
        const diff = await gitExec(["-C", worktreeDir, "diff", "--cached", "--binary", "HEAD"], { maxBuffer: WORKFLOW_RESOURCE_LIMITS.worktreePatchBytes });
        if (diff.stdout.trim()) await fs.promises.writeFile(patchPath, diff.stdout, "utf8");
        else delete artifacts.patchPath;
      } catch (err) {
        if (!fs.existsSync(patchPath)) delete artifacts.patchPath;
        errors.push(`worktree patch capture failed: ${(err as Error).message}`);
      }

      try {
        const ignored = await collectIgnoredArtifacts(worktreeDir, ignoredFilesDir, ignoredManifestPath);
        if (!ignored.manifestWritten) delete artifacts.ignoredManifestPath;
        if (!ignored.filesCopied) delete artifacts.ignoredFilesDir;
      } catch (err) {
        if (!fs.existsSync(ignoredManifestPath)) delete artifacts.ignoredManifestPath;
        if (!fs.existsSync(ignoredFilesDir)) delete artifacts.ignoredFilesDir;
        errors.push(`worktree ignored-file capture failed: ${(err as Error).message}`);
      }
      if (errors.length > 0) artifacts.error = errors.join("; ");
      return artifacts;
    },
    async cleanup() {
      await removeGitWorktree(git.root, worktreeDir);
    },
  };
}

async function collectIgnoredArtifacts(worktreeDir: string, ignoredFilesDir: string, ignoredManifestPath: string): Promise<{ manifestWritten: boolean; filesCopied: boolean }> {
  await fs.promises.rm(ignoredFilesDir, { recursive: true, force: true });
  await fs.promises.rm(ignoredManifestPath, { force: true });

  const listed = await gitExec(["-C", worktreeDir, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"], { encoding: "buffer", maxBuffer: WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredListBytes });
  const paths = listed.stdoutBuffer.toString("utf8").split("\0").filter(Boolean);
  const manifest: IgnoredArtifactManifest = {
    version: 1,
    kind: "worktree_ignored_files",
    limits: {
      maxFiles: WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredFiles,
      maxFileBytes: WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredFileBytes,
      maxTotalBytes: WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredTotalBytes,
    },
    totalBytes: 0,
    files: [],
    omitted: [],
  };
  let copied = 0;

  for (const relative of paths) {
    if (!isSafeRelativePath(relative)) {
      manifest.omitted.push({ path: relative, reason: "unsafe path" });
      continue;
    }

    const sourcePath = path.join(worktreeDir, relative);
    if (!isInside(worktreeDir, sourcePath)) {
      manifest.omitted.push({ path: relative, reason: "outside worktree" });
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(sourcePath);
    } catch (err) {
      manifest.omitted.push({ path: relative, reason: `stat failed: ${(err as Error).message}` });
      continue;
    }

    if (stat.isSymbolicLink()) {
      await recordIgnoredSymlink(sourcePath, relative, manifest);
      continue;
    }

    if (!stat.isFile()) {
      manifest.omitted.push({ path: relative, reason: "unsupported file type" });
      continue;
    }

    if (manifest.files.length >= WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredFiles) {
      manifest.omitted.push({ path: relative, reason: "file count limit", bytes: stat.size });
      continue;
    }
    if (stat.size > WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredFileBytes) {
      manifest.omitted.push({ path: relative, reason: "file size limit", bytes: stat.size });
      continue;
    }
    if (manifest.totalBytes + stat.size > WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredTotalBytes) {
      manifest.omitted.push({ path: relative, reason: "total size limit", bytes: stat.size });
      continue;
    }

    const targetPath = path.join(ignoredFilesDir, relative);
    if (!isInside(ignoredFilesDir, targetPath)) {
      manifest.omitted.push({ path: relative, reason: "unsafe artifact path", bytes: stat.size });
      continue;
    }
    await ensureDir(path.dirname(targetPath));
    await fs.promises.copyFile(sourcePath, targetPath);
    manifest.totalBytes += stat.size;
    copied++;
    manifest.files.push({ path: relative, type: "file", bytes: stat.size, artifactPath: relative });
  }

  if (manifest.files.length === 0 && manifest.omitted.length === 0) return { manifestWritten: false, filesCopied: false };
  await fs.promises.writeFile(ignoredManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestWritten: true, filesCopied: copied > 0 };
}

async function recordIgnoredSymlink(sourcePath: string, relative: string, manifest: IgnoredArtifactManifest): Promise<void> {
  try {
    if (manifest.files.length >= WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredFiles) {
      manifest.omitted.push({ path: relative, reason: "file count limit" });
      return;
    }
    const target = await fs.promises.readlink(sourcePath);
    const bytes = byteLength(target);
    if (bytes > WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredSymlinkBytes) {
      manifest.omitted.push({ path: relative, reason: "symlink target size limit", bytes });
      return;
    }
    if (manifest.totalBytes + bytes > WORKFLOW_RESOURCE_LIMITS.worktreeIgnoredTotalBytes) {
      manifest.omitted.push({ path: relative, reason: "total size limit", bytes });
      return;
    }
    manifest.files.push({ path: relative, type: "symlink", bytes, target });
    manifest.totalBytes += bytes;
  } catch (err) {
    manifest.omitted.push({ path: relative, reason: `readlink failed: ${(err as Error).message}` });
  }
}

async function getGitWorkspace(cwd: string): Promise<{ root: string; prefix: string }> {
  const root = (await gitExec(["-C", cwd, "rev-parse", "--show-toplevel"])).stdout.trim();
  const prefix = (await gitExec(["-C", cwd, "rev-parse", "--show-prefix"])).stdout.trim();
  if (!root) throw new Error("git root not found");
  return { root, prefix };
}

async function mirrorDirtyState(root: string, worktreeDir: string): Promise<void> {
  const diff = await gitExec(["-C", root, "diff", "--binary", "HEAD"], { maxBuffer: 100 * 1024 * 1024 });
  if (diff.stdout.trim()) await gitExecInput(["-C", worktreeDir, "apply", "--whitespace=nowarn", "--binary", "-"], diff.stdout);

  const untracked = await gitExec(["-C", root, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "buffer", maxBuffer: 100 * 1024 * 1024 });
  const files = untracked.stdoutBuffer.toString("utf8").split("\0").filter(Boolean);
  for (const relative of files) {
    if (!isSafeRelativePath(relative)) continue;
    const src = path.join(root, relative);
    const dst = path.join(worktreeDir, relative);
    if (!isInside(worktreeDir, dst)) continue;
    await ensureDir(path.dirname(dst));
    await fs.promises.cp(src, dst, { recursive: true, force: true, verbatimSymlinks: true });
  }
}

function isSafeRelativePath(relative: string): boolean {
  return relative !== "" && !path.isAbsolute(relative) && !relative.split(/[\\/]+/).includes("..");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function removeGitWorktree(root: string, worktreeDir: string): Promise<void> {
  await gitExec(["-C", root, "worktree", "remove", "--force", worktreeDir], { allowFailure: true });
  await fs.promises.rm(worktreeDir, { recursive: true, force: true });
  await gitExec(["-C", root, "worktree", "prune"], { allowFailure: true });
}

async function gitExec(args: string[], options: { allowFailure?: boolean; maxBuffer?: number; encoding?: "utf8" | "buffer" } = {}): Promise<{ stdout: string; stderr: string; stdoutBuffer: Buffer }> {
  const encoding = options.encoding ?? "utf8";
  return await new Promise((resolve, reject) => {
    execFile("git", args, { encoding: encoding as BufferEncoding, maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024, env: gitEnv() }, (err, stdout, stderr) => {
      const stdoutBuffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ""));
      const result = { stdout: stdoutBuffer.toString("utf8"), stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""), stdoutBuffer };
      if (err && !options.allowFailure) reject(new Error(`${["git", ...args].join(" ")} failed: ${result.stderr || (err as Error).message}`));
      else resolve(result);
    });
  });
}

async function gitExecInput(args: string[], input: string | Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("git", args, { stdio: ["pipe", "ignore", "pipe"], env: gitEnv() });
    const stderr: string[] = [];
    proc.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${["git", ...args].join(" ")} failed: ${stderr.join("")}`));
    });
    proc.stdin.end(input);
  });
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) return { command: process.execPath, args: [currentScript, ...args] };
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: "pi", args };
}
