import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "../types.js";
import { zeroUsage, type AgentFinishRecord, type UsageMeasurement } from "../runtime/durable-types.js";
import { diffCandidateTrees, scanCandidateTree, type CandidateTreeManifest } from "../candidates/tree.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import {
  MISSING_RECEIPT_REMINDER,
  type AgentEvent,
  type AgentExecutionRequest,
  type AgentExecutionResult,
} from "./executor.js";
import { AgentProtocolClient, type AgentWorkerProtocol } from "./sdk-protocol.js";
import { createSdkSemanticTools } from "./sdk-semantic-tools.js";
import { createAgentTerminalTools } from "./sdk-tools.js";

const SDK_BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);
const TERMINAL_TOOL_NAMES = ["finish_work", "report_progress", "log_result", "publish_artifact"] as const;

type SdkModel = NonNullable<CreateAgentSessionOptions["model"]>;

interface WorkerSession {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
  dispose(): void;
  getActiveToolNames(): string[];
  getAllTools(): Array<{ name: string; parameters: unknown }>;
  model?: { provider: string; id: string };
  thinkingLevel: string;
  messages: unknown[];
  agent: { continue(): Promise<void> };
}

export interface SdkAgentWorkerConfig {
  runDir: string;
  agentDir?: string;
  resultPath?: string;
  request: AgentExecutionRequest;
}

export interface SdkAgentWorkerDependencies {
  createSession?: (options: CreateAgentSessionOptions) => Promise<{
    session: WorkerSession;
    extensionsResult: { extensions: unknown[]; errors: unknown[] };
  }>;
  resolveModel?: (request: AgentExecutionRequest, agentDir: string) => SdkModel;
  openSessionManager?: (runDir: string, request: AgentExecutionRequest) => SessionManager;
  protocol?: AgentWorkerProtocol;
  semanticTools?: ToolDefinition[];
  now?: () => Date;
}

/** A loader with no discovery path at all. Credentials/model routing are separate SDK services. */
export function createIsolatedAgentResourceLoader(systemPrompt: string): ResourceLoader {
  if (typeof systemPrompt !== "string" || !systemPrompt.trim()) throw new TypeError("Agent system prompt is empty");
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return Object.freeze({
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  });
}

export async function runSdkAgentWorker(
  config: SdkAgentWorkerConfig,
  dependencies: SdkAgentWorkerDependencies = {},
): Promise<AgentExecutionResult> {
  const runDir = await validateWorkerRequest(config);
  const request = config.request;
  const agentDir = path.resolve(config.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "/", ".pi", "agent"));
  const now = dependencies.now ?? (() => new Date());
  const ownProtocol = dependencies.protocol === undefined;
  const protocol = dependencies.protocol ?? await AgentProtocolClient.connect({
    socketPath: request.protocol.socketPath,
    executionId: request.executionId,
    executionToken: request.protocol.executionToken,
  });
  const terminal = createAgentTerminalTools(protocol, request.outputSchema);
  const startedAt = performance.now();
  let session: WorkerSession | undefined;
  let unsubscribe: (() => void) | undefined;
  const usage = zeroUsage();
  const events = new WorkerEventStream(request, protocol, now, usage);
  let workspaceBefore: CandidateTreeManifest | undefined;
  let workspaceObserved = false;

  try {
    workspaceBefore = request.workspace.mode === "candidate"
      ? await scanCandidateTree(request.workspace.root)
      : undefined;
    const semanticTools = exactSemanticTools(
      request,
      dependencies.semanticTools ?? createSdkSemanticTools(protocol, request),
    );
    const activeToolNames = [...request.tools.map((tool) => tool.name), ...TERMINAL_TOOL_NAMES];
    if (activeToolNames.includes("workflow")) throw new Error("The workflow tool is never available to an SDK agent worker");
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2, provider: { maxRetries: 2 } },
      enableSkillCommands: false,
    });
    const sessionManager = dependencies.openSessionManager
      ? dependencies.openSessionManager(runDir, request)
      : await openPinnedAgentSession(runDir, request);
    if (request.instruction.kind === "resume") rewindRetryableAssistantFailure(sessionManager);
    const model = dependencies.resolveModel
      ? dependencies.resolveModel(request, agentDir)
      : resolvePinnedModel(request, agentDir);
    const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
    const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
    const resourceLoader = createIsolatedAgentResourceLoader(buildSystemPrompt(request));
    const createSession = dependencies.createSession ?? (createAgentSession as SdkAgentWorkerDependencies["createSession"]);
    const created = await createSession!({
      cwd: request.workspace.cwd,
      agentDir,
      model,
      thinkingLevel: request.route.thinking,
      authStorage,
      modelRegistry,
      resourceLoader,
      settingsManager,
      sessionManager,
      noTools: "all",
      tools: activeToolNames,
      customTools: [...semanticTools, ...terminal.tools],
    });
    if (created.extensionsResult.extensions.length || created.extensionsResult.errors.length) {
      throw new Error("SDK agent resource isolation admitted an ambient extension");
    }
    session = created.session;
    assertExactActiveTools(session, activeToolNames, request);
    assertExactRoute(session, request);
    unsubscribe = session.subscribe((event) => events.observe(event, terminal.committedFinish()));
    await events.emit({ type: "execution-start", pid: process.pid });
    await events.emit({ type: "session-open", agentSessionId: request.session.agentSessionId, resumed: request.session.resume });

    await dispatchInstruction(session, request);
    await observeWorkspaceChange(request, workspaceBefore, events);
    workspaceObserved = true;
    await events.drain();

    const finish = terminal.committedFinish();
    if (finish) {
      usage.elapsedMs = elapsedSince(startedAt);
      await events.emit({ type: "termination", outcome: "finished" });
      await events.drain();
      return { outcome: "finished", finish, usage, transcriptComplete: events.complete };
    }
    const providerFailure = lastAssistantFailure(session.messages);
    if (providerFailure) {
      usage.elapsedMs = elapsedSince(startedAt);
      usage.complete = false;
      const reason = {
        category: "provider" as const,
        code: "provider-failed",
        summary: bounded(providerFailure, 2_000),
        retryable: true,
        operationId: request.operationId,
      };
      await events.emit({ type: "termination", outcome: "failed", reason });
      await events.drain();
      return {
        outcome: "failed",
        reason,
        meaningfulProgress: events.meaningfulProgress,
        usage,
        transcriptComplete: events.complete,
      };
    }
    await events.emit({
      type: "termination",
      outcome: "yielded",
      reason: {
        category: "agent-protocol",
        code: "missing-finish-work",
        summary: "Agent yielded without an acknowledged finish_work call",
        retryable: true,
        operationId: request.operationId,
      },
    });
    await events.drain();
    usage.elapsedMs = elapsedSince(startedAt);
    return {
      outcome: "yielded",
      clean: true,
      meaningfulProgress: events.meaningfulProgress,
      usage,
      transcriptComplete: events.complete,
    };
  } catch (error) {
    usage.elapsedMs = elapsedSince(startedAt);
    usage.complete = false;
    if (!workspaceObserved) {
      await observeWorkspaceChange(request, workspaceBefore, events).catch(() => undefined);
      workspaceObserved = true;
    }
    await events.drain().catch(() => undefined);
    const reason = {
      category: "infrastructure" as const,
      code: "sdk-worker-failed",
      summary: bounded(error instanceof Error ? error.message : String(error), 2_000),
      retryable: true,
      operationId: request.operationId,
    };
    await events.emit({ type: "termination", outcome: "failed", reason }).catch(() => undefined);
    await events.drain().catch(() => undefined);
    return {
      outcome: "failed",
      reason,
      meaningfulProgress: events.meaningfulProgress,
      usage,
      transcriptComplete: false,
    };
  } finally {
    unsubscribe?.();
    session?.dispose();
    if (ownProtocol) await protocol.close().catch(() => undefined);
  }
}

export async function agentWorkerMain(args: readonly string[]): Promise<number> {
  if (args.length !== 2 || args[0] !== "--config" || !args[1] || !path.isAbsolute(args[1])) {
    throw new Error("Usage: agent-worker-entry.js --config ABSOLUTE_CONFIG_JSON");
  }
  const stat = await fs.promises.lstat(args[1]);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("Unsafe SDK agent worker configuration");
  const source = await fs.promises.readFile(args[1], "utf8");
  const config = JSON.parse(source) as SdkAgentWorkerConfig;
  const result = await runSdkAgentWorker(config);
  const serialized = `${stableJson(result)}\n`;
  if (config.resultPath) await writeWorkerResult(config.runDir, config.request, config.resultPath, serialized);
  else process.stdout.write(serialized);
  return result.outcome === "failed" ? 1 : 0;
}

export function agentWorkerEntryPath(): string {
  return fileURLToPath(new URL("./agent-worker-entry.js", import.meta.url));
}

export async function openPinnedAgentSession(runDirInput: string, request: AgentExecutionRequest): Promise<SessionManager> {
  const runDir = path.resolve(runDirInput);
  const expectedRelative = `sessions/${request.executionId}/session.jsonl`;
  if (request.session.piSessionPath !== expectedRelative) {
    throw new Error(`Pi session path must be ${expectedRelative}`);
  }
  const target = path.join(runDir, ...expectedRelative.split("/"));
  const directory = path.dirname(target);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertContainedRealDirectories(runDir, directory);
  if (request.session.resume) {
    const stat = await fs.promises.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Persisted Pi session is unsafe");
    return SessionManager.open(target, directory, request.workspace.cwd);
  }
  try { await fs.promises.lstat(target); throw new Error("New Pi session path already exists"); }
  catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  const created = SessionManager.create(request.workspace.cwd, directory);
  const generated = created.getSessionFile();
  if (!generated || path.dirname(generated) !== directory) throw new Error("Pi SDK created its session outside the execution directory");
  const header = created.getHeader();
  if (!header) throw new Error("Pi SDK did not create a session header");
  const handle = await fs.promises.open(target, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(header)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rm(generated, { force: true });
  const directoryHandle = await fs.promises.open(directory, "r");
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  return SessionManager.open(target, directory, request.workspace.cwd);
}

/** Keep failed or interrupted assistant output as evidence while retrying from its exact parent context. */
export function rewindRetryableAssistantFailure(sessionManager: SessionManager): boolean {
  const branch = sessionManager.getBranch();
  const leaf = branch.at(-1);
  if (!leaf || leaf.type !== "message" || leaf.message.role !== "assistant") return false;
  const message = leaf.message as { stopReason?: unknown; content?: unknown };
  const incompleteToolTurn = message.stopReason === "toolUse"
    && Array.isArray(message.content)
    && message.content.some((entry: any) => entry?.type === "toolCall");
  if ((message.stopReason !== "error" && !incompleteToolTurn) || typeof leaf.parentId !== "string") return false;
  sessionManager.branch(leaf.parentId);
  return true;
}

class WorkerEventStream {
  private sequence = 0;
  private turn = 0;
  private chain: Promise<void> = Promise.resolve();
  private failure?: unknown;
  meaningfulProgress = false;
  private readonly request: AgentExecutionRequest;
  private readonly protocol: AgentWorkerProtocol;
  private readonly now: () => Date;
  private readonly usage: UsageMeasurement;

  constructor(
    request: AgentExecutionRequest,
    protocol: AgentWorkerProtocol,
    now: () => Date,
    usage: UsageMeasurement,
  ) {
    this.request = request;
    this.protocol = protocol;
    this.now = now;
    this.usage = usage;
  }

  get complete(): boolean { return this.failure === undefined; }

  observe(event: AgentSessionEvent, finish?: AgentFinishRecord): void {
    switch (event.type) {
      case "turn_start":
        this.turn += 1;
        this.enqueue({ type: "model-start", model: this.request.route.model, turn: this.turn });
        break;
      case "turn_end":
        addAssistantUsage(this.usage, event.message);
        const stopReason = assistantStopReason(event.message);
        this.enqueue({
          type: "model-end",
          turn: this.turn,
          usage: usageFromAssistant(event.message),
          ...(stopReason ? { stopReason } : {}),
        });
        break;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          for (const text of chunks(event.assistantMessageEvent.delta, 8_000)) this.enqueue({ type: "assistant-text", text });
        }
        break;
      case "tool_execution_start":
        this.enqueue({ type: "tool-start", toolCallId: event.toolCallId, toolName: event.toolName, input: safeJson(event.args) });
        if (event.toolName === "finish_work") this.enqueue({ type: "finish-requested", toolCallId: event.toolCallId });
        break;
      case "tool_execution_update":
        this.enqueue({
          type: "tool-update",
          toolCallId: event.toolCallId,
          text: bounded(stableJson(safeJson(event.partialResult)), 16_000),
        });
        break;
      case "tool_execution_end":
        this.enqueue({ type: "tool-end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
        this.meaningfulProgress ||= !event.isError && event.toolName !== "finish_work" && event.toolName !== "report_progress";
        if (event.toolName === "finish_work" && finish) this.enqueue({ type: "finish-committed", finish });
        break;
      case "compaction_start":
        this.enqueue({ type: "compaction-start" });
        break;
      case "compaction_end":
        this.enqueue({ type: "compaction-end", summaryBytes: Buffer.byteLength(JSON.stringify(event.result ?? "")) });
        break;
      case "auto_retry_start":
        this.enqueue({ type: "provider-retry", delayMs: event.delayMs, message: bounded(event.errorMessage, 2_000) });
        break;
      default:
        break;
    }
  }

  async emit(event: EventPayload): Promise<void> {
    this.enqueue(event);
    await this.drain();
  }

  async workspaceChange(treeHash: string, changedPaths: string[]): Promise<void> {
    this.meaningfulProgress = true;
    await this.emit({ type: "workspace-change", treeHash, changedPaths });
  }

  async drain(): Promise<void> {
    await this.chain;
    if (this.failure) throw this.failure;
  }

  private enqueue(payload: EventPayload): void {
    const event = {
      ...payload,
      executionId: this.request.executionId,
      operationId: this.request.operationId,
      attemptId: this.request.attemptId,
      sequence: ++this.sequence,
      at: this.timestamp(),
    } as AgentEvent;
    this.chain = this.chain.then(() => this.protocol.emit(event)).catch((error) => {
      this.failure ??= error;
    });
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("SDK worker clock returned an invalid date");
    return value.toISOString();
  }
}

type EventPayload = AgentEvent extends infer Event
  ? Event extends AgentEvent ? Omit<Event, "executionId" | "operationId" | "attemptId" | "sequence" | "at"> : never
  : never;

function exactSemanticTools(request: AgentExecutionRequest, supplied: ToolDefinition[]): ToolDefinition[] {
  const suppliedByName = new Map(supplied.map((tool) => [tool.name, tool]));
  if (suppliedByName.size !== supplied.length) throw new Error("Duplicate SDK semantic tool definition");
  const selected: ToolDefinition[] = [];
  for (const descriptor of request.tools) {
    if (TERMINAL_TOOL_NAMES.includes(descriptor.name as typeof TERMINAL_TOOL_NAMES[number]) || descriptor.name === "workflow") {
      throw new Error(`Semantic authority may not override reserved tool ${descriptor.name}`);
    }
    if (SDK_BUILTIN_TOOLS.has(descriptor.name)) continue;
    const custom = suppliedByName.get(descriptor.name);
    if (!custom) throw new Error(`SDK worker has no exact implementation for semantic tool ${descriptor.name}`);
    selected.push(custom);
  }
  const unexpected = selected.filter((tool) => !request.tools.some((descriptor) => descriptor.name === tool.name));
  if (unexpected.length) throw new Error(`SDK worker received unrequested semantic tools: ${unexpected.map((tool) => tool.name).join(", ")}`);
  return selected;
}

async function observeWorkspaceChange(
  request: AgentExecutionRequest,
  before: CandidateTreeManifest | undefined,
  events: WorkerEventStream,
): Promise<void> {
  if (!before || request.workspace.mode !== "candidate") return;
  const after = await scanCandidateTree(request.workspace.root);
  if (after.treeHash === before.treeHash) return;
  const changedPaths = [...new Set(diffCandidateTrees(before, after).map((change) => change.path))]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .slice(0, 256);
  await events.workspaceChange(after.treeHash, changedPaths);
}

function assertExactActiveTools(session: WorkerSession, expected: string[], request: AgentExecutionRequest): void {
  const active = [...session.getActiveToolNames()].sort();
  const wanted = [...expected].sort();
  if (stableHash(active) !== stableHash(wanted)) throw new Error(`Pi SDK activated unexpected tools: ${active.join(", ")}`);
  if (active.includes("workflow")) throw new Error("Pi SDK exposed forbidden workflow authority");
  const catalog = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
  if (catalog.has("workflow")) throw new Error("Pi SDK registered forbidden workflow authority");
  for (const descriptor of request.tools) {
    const tool = catalog.get(descriptor.name);
    if (!tool) throw new Error(`Pi SDK omitted admitted tool ${descriptor.name}`);
    const schemaHash = stableHash(tool.parameters).slice(7);
    if (schemaHash !== descriptor.schemaHash) throw new Error(`Pi SDK schema for ${descriptor.name} differs from admitted authority`);
  }
}

function assertExactRoute(session: WorkerSession, request: AgentExecutionRequest): void {
  const prefix = `${request.route.provider}/`;
  const modelId = request.route.model.startsWith(prefix) ? request.route.model.slice(prefix.length) : "";
  if (!session.model || session.model.provider !== request.route.provider || session.model.id !== modelId) {
    throw new Error(`Pi SDK did not preserve exact pinned model ${request.route.model}`);
  }
  if (session.thinkingLevel !== request.route.thinking) {
    throw new Error(`Pi SDK clamped pinned thinking ${request.route.thinking} to ${session.thinkingLevel}`);
  }
}

function resolvePinnedModel(request: AgentExecutionRequest, agentDir: string): SdkModel {
  const auth = AuthStorage.create(path.join(agentDir, "auth.json"));
  const registry = ModelRegistry.create(auth, path.join(agentDir, "models.json"));
  const prefix = `${request.route.provider}/`;
  if (!request.route.model.startsWith(prefix) || request.route.model.length === prefix.length) {
    throw new Error(`Pinned route model ${request.route.model} does not belong to ${request.route.provider}`);
  }
  const model = registry.find(request.route.provider, request.route.model.slice(prefix.length));
  if (!model) throw new Error(`Pinned model ${request.route.model} is unavailable`);
  return model;
}

function buildSystemPrompt(request: AgentExecutionRequest): string {
  const context = request.context.entries.map((entry) => `## ${entry.id} (${entry.path})\n${entry.text}`).join("\n\n");
  return [
    request.profile.instructions,
    request.workspace.mode === "candidate"
      ? "You are working in a disposable candidate workspace. Never claim to have edited the live project."
      : "You are inspecting an immutable project snapshot. Do not attempt to modify it.",
    "Use only the active tools and pinned artifact inputs. No ambient extensions, skills, prompts, themes, or context exist.",
    "When an immutable artifact is required, write it below /outputs and call publish_artifact with its relative path.",
    "Assistant final text is evidence only and never completes this task. Call finish_work with the exact requested schema to complete successfully.",
    context ? `# Pinned project guidance\n${context}` : "",
  ].filter(Boolean).join("\n\n");
}

async function dispatchInstruction(session: WorkerSession, request: AgentExecutionRequest): Promise<void> {
  if (request.instruction.kind === "resume") {
    const last = session.messages.at(-1) as { role?: unknown } | undefined;
    if (last?.role === "assistant") {
      await session.prompt(MISSING_RECEIPT_REMINDER, { expandPromptTemplates: false });
    } else {
      await session.agent.continue();
    }
    return;
  }
  const inputs = request.inputs.entries.length
    ? request.inputs.entries.map((entry) => `- ${entry.id}: ${entry.path} (${entry.artifact.digest})`).join("\n")
    : "- none";
  const prompt = request.instruction.kind === "initial-task"
    ? `${request.instruction.task}\n\nPinned artifact inputs:\n${inputs}`
    : request.instruction.text;
  await session.prompt(prompt, { expandPromptTemplates: false });
}

async function validateWorkerRequest(config: SdkAgentWorkerConfig): Promise<string> {
  if (!config || typeof config !== "object" || !config.request) throw new TypeError("Invalid SDK worker configuration");
  const runDir = path.resolve(config.runDir);
  const [stat, real] = await Promise.all([fs.promises.lstat(runDir), fs.promises.realpath(runDir)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== runDir) throw new Error("Unsafe SDK worker run directory");
  if (config.request.runId !== path.basename(runDir)) throw new Error("SDK worker run directory and request identity differ");
  if (config.request.route.profileId !== config.request.profile.id) throw new Error("SDK worker route and profile identities differ");
  if (config.request.workspace.preTreeHash !== config.request.workspace.workspace.treeHash) throw new Error("SDK worker workspace pre-state is inconsistent");
  return runDir;
}

async function writeWorkerResult(
  runDirInput: string,
  request: AgentExecutionRequest,
  resultPathInput: string,
  serialized: string,
): Promise<void> {
  const runDir = path.resolve(runDirInput);
  const expected = path.join(runDir, "sessions", request.executionId, "worker-result.json");
  const resultPath = path.resolve(resultPathInput);
  if (resultPath !== expected) throw new Error("SDK worker result path is not canonical");
  await assertContainedRealDirectories(runDir, path.dirname(resultPath));
  const temporary = `${resultPath}.tmp-${process.pid}`;
  const handle = await fs.promises.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(temporary, resultPath);
  const directory = await fs.promises.open(path.dirname(resultPath), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function assertContainedRealDirectories(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Pi session directory escapes the run");
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.promises.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Pi session path contains an unsafe directory");
  }
}

function addAssistantUsage(total: UsageMeasurement, message: unknown): void {
  const usage = usageFromAssistant(message);
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
  total.providerRequests += usage.providerRequests;
  total.cost += usage.cost;
  total.complete &&= usage.complete;
}

function usageFromAssistant(message: unknown): UsageMeasurement {
  const object = message && typeof message === "object" ? message as Record<string, any> : {};
  const usage = object.usage && typeof object.usage === "object" ? object.usage : {};
  return {
    inputTokens: nonnegativeInteger(usage.input),
    outputTokens: nonnegativeInteger(usage.output),
    cacheReadTokens: nonnegativeInteger(usage.cacheRead),
    cacheWriteTokens: nonnegativeInteger(usage.cacheWrite),
    providerRequests: object.role === "assistant" ? 1 : 0,
    cost: typeof usage.cost?.total === "number" && Number.isFinite(usage.cost.total) && usage.cost.total >= 0 ? usage.cost.total : 0,
    elapsedMs: 0,
    complete: object.role === "assistant" && usage.input !== undefined && usage.output !== undefined,
  };
}

function assistantStopReason(message: unknown): string | undefined {
  return message && typeof message === "object" && typeof (message as any).stopReason === "string"
    ? bounded((message as any).stopReason, 256)
    : undefined;
}

function lastAssistantFailure(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as any;
    if (message?.role !== "assistant") continue;
    return message.stopReason === "error" || message.stopReason === "aborted"
      ? String(message.errorMessage ?? `Provider stopped with ${message.stopReason}`)
      : undefined;
  }
  return undefined;
}

function safeJson(value: unknown): JsonValue {
  try { return JSON.parse(JSON.stringify(value ?? null)) as JsonValue; }
  catch { return null; }
}

function chunks(value: string, maximum: number): string[] {
  const scalars = Array.from(value);
  const result: string[] = [];
  for (let index = 0; index < scalars.length; index += maximum) result.push(scalars.slice(index, index + maximum).join(""));
  return result;
}

function bounded(value: string, maximum: number): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, maximum).join("") || "Agent worker failed";
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.floor(performance.now() - startedAt));
}

