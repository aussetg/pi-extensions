import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunRecord, ToolResult, WorkflowInput, WorkflowLaunchOutput, WorkflowUsage } from "../types.js";
import { CHAT_PREVIEW_BYTES, DEFAULT_LIMITS, SCRIPT_MAX_BYTES, WORKFLOW_RESOURCE_LIMITS, WORKFLOW_RESULT_MESSAGE } from "../constants.js";
import { WorkflowRegistry } from "../persistence/registry.js";
import { RunStore } from "../persistence/run-store.js";
import { registryRefreshOptions } from "../persistence/trust.js";
import { JsonlJournal } from "../persistence/journal.js";
import { resolveLocalPath } from "../persistence/paths.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";
import { parseWorkflowScript, type ParsedWorkflowScript } from "./parser.js";
import { WorkflowBudget } from "./budget.js";
import { RunControl } from "./run-control.js";
import { WorkflowAgentQuota, WorkflowScheduler } from "./scheduler.js";
import { executeWorkflowSandbox } from "./sandbox.js";
import type { SandboxRpcContext } from "./sandbox-types.js";
import { WorkflowProgressComponent } from "../ui/workflow-result-component.js";
import { nowIso } from "../utils/ids.js";
import { truncateForChat } from "../utils/truncate.js";
import { toStableJsonValue } from "../utils/stable-json.js";
import { defaultAgentThinkingFromContext, type ModelRegistryModelLike } from "../thinking.js";
import { WorkflowAbortError, WorkflowAgentCapError, WorkflowBudgetExceededError } from "./errors.js";

export interface WorkflowRunnerDeps {
  pi: ExtensionAPI;
  runStore: RunStore;
  registry: WorkflowRegistry;
  childDepth?: number;
  budget?: WorkflowBudget;
  agentQuota?: WorkflowAgentQuota;
}

export interface LaunchArgs {
  toolCallId: string;
  input: WorkflowInput;
  signal?: AbortSignal;
  onUpdate?: (partial: ToolResult<WorkflowLaunchOutput & { progress?: unknown }>) => void;
  ctx: any;
}

interface ResolvedWorkflowSource {
  source: string;
  originalPath?: string;
  parsed: ParsedWorkflowScript;
}

export class WorkflowRunner {
  constructor(private readonly deps: WorkflowRunnerDeps) {}

  async launchOrRun(args: LaunchArgs): Promise<WorkflowLaunchOutput> {
    validateInput(args.input);
    const ctx = args.ctx;
    await this.deps.registry.refresh(ctx.cwd, registryRefreshOptions(ctx));
    await this.deps.runStore.refresh(ctx.cwd);
    const resolved = await this.resolveSource(args.input, ctx.cwd);
    const stableArgs = (args.input.args ? toStableJsonValue(args.input.args) : {}) as Record<string, unknown>;

    if (args.input.resumeFromRunId) {
      const source = this.deps.runStore.get(args.input.resumeFromRunId);
      if (!source) throw new Error(`Unknown workflow run to resume: ${args.input.resumeFromRunId}`);
      if (source?.status === "running" || source?.status === "paused") throw new Error(`Cannot resume from running workflow ${args.input.resumeFromRunId}; stop it first.`);
    }

    const sessionId = ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager?.getHeader?.()?.id ?? "unknown-session";
    const defaultAgentThinking = defaultAgentThinkingFromContext(ctx);
    const modelRegistryModels = getModelRegistryModels(ctx);
    const { record } = await this.deps.runStore.create({
      cwd: ctx.cwd,
      sessionId,
      taskId: args.toolCallId,
      meta: resolved.parsed.meta,
      source: resolved.source,
      args: stableArgs,
      resumeFromRunId: args.input.resumeFromRunId,
    });

    const control = new RunControl();
    if (args.signal) args.signal.addEventListener("abort", () => control.stop("tool call aborted"), { once: true });
    this.deps.runStore.registerControl(record.runId, control);

    const mode = args.input.mode ?? (ctx.hasUI ? "async" : "await");
    const execute = (onUpdate: LaunchArgs["onUpdate"] | undefined) => this.executeRun({ record, resolved, stableArgs, input: args.input, ctx, control, defaultAgentThinking, modelRegistryModels, onUpdate });

    const runInBackground = mode === "async" && !args.onUpdate;

    if (runInBackground) {
      const donePromise = Promise.resolve()
        .then(() => execute(undefined))
        .then((result) => {
          if (this.deps.runStore.shouldNotifyOnComplete(record.runId)) this.sendCompletion(result);
        })
        .catch((err) => {
          if (this.deps.runStore.shouldNotifyOnComplete(record.runId)) this.sendCompletion(failedOutput(record, err));
        })
        .finally(() => this.deps.runStore.unregisterLiveRun(record.runId));
      this.deps.runStore.registerLiveRun({ runId: record.runId, sessionId, control, donePromise, notifyOnComplete: true });
      return asyncOutput(record);
    }

    const donePromise = Promise.resolve().then(() => execute(args.onUpdate));
    this.deps.runStore.registerLiveRun({ runId: record.runId, sessionId, control, donePromise, notifyOnComplete: false });
    try {
      const result = await donePromise;
      return result;
    } finally {
      this.deps.runStore.unregisterLiveRun(record.runId);
    }
  }

  private async executeRun(args: { record: RunRecord; resolved: ResolvedWorkflowSource; stableArgs: Record<string, unknown>; input: WorkflowInput; ctx: any; control: RunControl; defaultAgentThinking?: ReturnType<typeof defaultAgentThinkingFromContext>; modelRegistryModels?: readonly ModelRegistryModelLike[]; onUpdate?: LaunchArgs["onUpdate"] }): Promise<WorkflowLaunchOutput> {
    const { record, resolved, stableArgs, input, ctx, control, defaultAgentThinking, modelRegistryModels } = args;
    const journal = new JsonlJournal(record.journalPath);
    let progressComponent: WorkflowProgressComponent | undefined;
    let progressRenderTimer: NodeJS.Timeout | undefined;
    const showInlineProgress = !!args.onUpdate;
    const showStandardProgress = !!ctx.hasUI && !args.onUpdate;
    const tickProgress = showInlineProgress || showStandardProgress;
    const updateStandardProgress = () => {
      if (!showStandardProgress) return;
      try {
        ctx.ui?.setWidget?.(standardProgressKey(record), (_tui: any, theme: any) => {
          if (!progressComponent) progressComponent = new WorkflowProgressComponent(() => asyncOutput(record), theme);
          else progressComponent.invalidate();
          return progressComponent;
        }, { placement: "aboveEditor" });
      } catch {
        // Standard live progress is best-effort; artifacts and completion messages remain authoritative.
      }
    };
    const startProgressTicker = () => {
      if (!tickProgress || progressRenderTimer) return;
      progressRenderTimer = setInterval(() => {
        if (record.status !== "running" && record.status !== "paused") return;
        if (showInlineProgress) emitProgress();
        else {
          progressComponent?.invalidate();
          updateStandardProgress();
        }
      }, 1_000);
      progressRenderTimer.unref?.();
    };
    const stopProgressTicker = () => {
      if (!progressRenderTimer) return;
      clearInterval(progressRenderTimer);
      progressRenderTimer = undefined;
    };
    const emitProgress = () => {
      updateStandardProgress();
      try {
        args.onUpdate?.({ content: [{ type: "text", text: progressSummary(record) }], details: { ...asyncOutput(record), progress: record.progress } as WorkflowLaunchOutput & { progress: unknown } });
      } catch {
        // Progress rendering is best-effort; it should never change workflow semantics.
      }
    };
    let result: unknown;
    let failure: unknown;
    let failed = false;
    try {
      await journal.append({ type: "workflow_started", runId: record.runId, time: nowIso(), scriptHash: record.scriptHash, argsHash: record.argsHash });
      updateStandardProgress();
      startProgressTicker();

      const budget = this.deps.budget ?? new WorkflowBudget(input.budgetTokens ?? null);
      const agentQuota = this.deps.agentQuota ?? new WorkflowAgentQuota(Math.min(input.maxAgents ?? DEFAULT_LIMITS.agentCap, DEFAULT_LIMITS.agentCap));
      const scheduler = new WorkflowScheduler({
        cwd: ctx.cwd,
        run: record,
        journal,
        control,
        budget,
        maxAgents: agentQuota.total,
        agentQuota,
        defaultThinking: defaultAgentThinking,
        modelRegistryModels,
        activeTools: safeActiveTools(this.deps.pi),
        persist: () => this.deps.runStore.scheduleSave(record),
        onProgress: emitProgress,
      });

      const globals = {
        agent: (prompt: unknown, opts?: unknown, rpc?: SandboxRpcContext) => scheduler.agentCall(prompt, opts === undefined ? {} : opts, rpc?.signal),
        apply: (patch: unknown, rpc?: SandboxRpcContext) => scheduler.applyPatch(patch, rpc?.signal),
        phase: (title: string) => scheduler.phase(title),
        log: (message: string) => scheduler.log(message),
        workflow: async (nameOrRef: unknown, childArgs?: unknown, rpc?: SandboxRpcContext) => {
          if ((this.deps.childDepth ?? 0) >= 1) throw new Error("Nested child workflows are limited to one level");
          const childInput = childWorkflowInput(nameOrRef, childArgs);
          const child = new WorkflowRunner({ ...this.deps, childDepth: (this.deps.childDepth ?? 0) + 1, budget, agentQuota });
          const childSignal = linkAbortSignals(control.signal, rpc?.signal);
          try {
            const output = await child.launchOrRun({ toolCallId: `${record.taskId}_child`, input: childInput, signal: childSignal.signal, ctx });
            addUsage(record.usage, output.usage);
            this.deps.runStore.scheduleSave(record);
            emitProgress();
            if (output.status === "failed") throw childWorkflowError(output);
            if (!output.outputPath) return output;
            const parsed = JSON.parse(await readBoundedTextFile(output.outputPath, WORKFLOW_RESOURCE_LIMITS.workflowOutputBytes)) as { result?: unknown };
            return parsed.result ?? null;
          } finally {
            childSignal.cleanup();
          }
        },
        args: stableArgs,
        budget,
        cwd: ctx.cwd,
      };

      result = await executeWorkflowSandbox(resolved.parsed.executableSource, globals, control.signal);
      throwIfAborted(control.signal);
      throwIfShutdownAborted(record);
      record.status = "completed";
      record.endedAt = nowIso();
      const outputPath = path.join(record.runDir, "output.json");
      await fs.promises.writeFile(outputPath, `${JSON.stringify({ result }, null, 2)}\n`, "utf8");
      record.outputPath = outputPath;
      throwIfAborted(control.signal);
      throwIfShutdownAborted(record);
      await journal.append({ type: "workflow_completed", runId: record.runId, time: nowIso(), outputPath, usage: record.usage });
    } catch (err) {
      failed = true;
      failure = err;
      const aborted = err instanceof WorkflowAbortError || control.signal.aborted;
      if (!aborted) control.stop("workflow failed");
      const error = aborted ? "Workflow aborted" : errorMessage(err);
      record.status = aborted ? "aborted" : "failed";
      record.endedAt = nowIso();
      delete record.outputPath;
      const errorPath = path.join(record.runDir, "error.json");
      try {
        await fs.promises.writeFile(errorPath, `${JSON.stringify({ error, stack: err instanceof Error ? err.stack : undefined }, null, 2)}\n`, "utf8");
        record.errorPath = errorPath;
      } catch {
        // The terminal run record is still authoritative when an error artifact cannot be written.
      }
      await journal.append({ type: "workflow_failed", runId: record.runId, time: nowIso(), error, errorPath: record.errorPath }).catch(() => undefined);
    } finally {
      stopProgressTicker();
      if (showStandardProgress) clearStandardProgress(ctx, record);

      // A failed queued progress save must not prevent the terminal save from being attempted.
      await this.deps.runStore.flush(record.runId).catch(() => undefined);
      await this.deps.runStore.saveNow(record);
    }

    return failed ? failedOutput(record, failure) : completedOutput(record, result);
  }

  private async resolveSource(input: WorkflowInput, cwd: string): Promise<ResolvedWorkflowSource> {
    let source: string;
    let originalPath: string | undefined;
    if (input.scriptPath) {
      originalPath = resolveLocalPath(cwd, input.scriptPath);
      source = await readBoundedTextFile(originalPath, SCRIPT_MAX_BYTES);
    } else if (input.name) {
      const ref = this.deps.registry.get(input.name);
      if (!ref) throw new Error(`Unknown workflow: ${input.name}`);
      originalPath = ref.path;
      source = await readBoundedTextFile(ref.path, SCRIPT_MAX_BYTES);
    } else {
      source = input.script!;
    }
    return { source, originalPath, parsed: parseWorkflowScript(source) };
  }

  private sendCompletion(result: WorkflowLaunchOutput): void {
    try {
      this.deps.pi.sendMessage?.(
        {
          customType: WORKFLOW_RESULT_MESSAGE,
          content: result.summary,
          display: true,
          details: result,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch {
      // Completion delivery is best-effort; the run artifacts still contain the result.
    }
  }
}

function childWorkflowInput(nameOrRef: unknown, args: unknown): WorkflowInput {
  const childArgs = args === undefined ? undefined : validateArgsObject(args, "workflow() child args");
  if (typeof nameOrRef === "string" && nameOrRef.trim() !== "") return { name: nameOrRef, args: childArgs, mode: "await" };
  if (nameOrRef && typeof nameOrRef === "object" && !Array.isArray(nameOrRef) && typeof (nameOrRef as any).scriptPath === "string" && (nameOrRef as any).scriptPath.trim() !== "") {
    return { scriptPath: (nameOrRef as any).scriptPath, args: childArgs, mode: "await" };
  }
  throw new Error("workflow(nameOrRef, args?) expects a workflow name string or { scriptPath }");
}

const WORKFLOW_INPUT_KEYS = new Set(["script", "name", "scriptPath", "args", "resumeFromRunId", "mode", "budgetTokens", "maxAgents"]);

function validateInput(input: WorkflowInput): void {
  if (!input || typeof input !== "object") throw new Error("workflow input must be an object");
  if (Array.isArray(input)) throw new Error("workflow input must be an object");
  for (const key of Object.keys(input as Record<string, unknown>)) {
    if (!WORKFLOW_INPUT_KEYS.has(key)) throw new Error(`Unknown workflow input field: ${key}`);
  }
  const sources = [
    ["script", input.script],
    ["name", input.name],
    ["scriptPath", input.scriptPath],
  ] as const;
  const present = sources.filter(([, value]) => value !== undefined);
  for (const [key, value] of present) {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`workflow source ${key} must be a non-empty string`);
  }
  if (present.length !== 1) throw new Error("workflow requires exactly one of script, name, or scriptPath");
  if (input.args !== undefined) validateArgsObject(input.args, "workflow args");
  if (input.resumeFromRunId !== undefined && (typeof input.resumeFromRunId !== "string" || input.resumeFromRunId.trim() === "")) throw new Error("workflow resumeFromRunId must be a non-empty string");
  if (input.mode !== undefined && input.mode !== "await" && input.mode !== "async") throw new Error("workflow mode must be await or async");
  if (input.budgetTokens !== undefined && (!Number.isInteger(input.budgetTokens) || input.budgetTokens < 1)) throw new Error("workflow budgetTokens must be a positive integer");
  if (input.maxAgents !== undefined && (!Number.isInteger(input.maxAgents) || input.maxAgents < 1 || input.maxAgents > DEFAULT_LIMITS.agentCap)) throw new Error(`workflow maxAgents must be an integer from 1 to ${DEFAULT_LIMITS.agentCap}`);
}

function validateArgsObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return toStableJsonValue(value) as Record<string, unknown>;
}

function addUsage(target: WorkflowUsage, usage: WorkflowUsage | undefined): void {
  if (!usage) return;
  target.agentCount += usage.agentCount;
  target.subagentTokens += usage.subagentTokens;
  target.toolUses += usage.toolUses;
  if (usage.durationMs !== undefined) target.durationMs = (target.durationMs ?? 0) + usage.durationMs;
  target.estimated = target.estimated || usage.estimated;
}

function childWorkflowError(output: WorkflowLaunchOutput): Error {
  const message = output.error ?? `Child workflow ${output.name} failed`;
  if (/budget/i.test(message)) return new WorkflowBudgetExceededError(message);
  if (/agent cap/i.test(message)) return new WorkflowAgentCapError(message);
  return new Error(message);
}

function asyncOutput(record: RunRecord): WorkflowLaunchOutput {
  const status = launchOutputStatus(record);
  return {
    status,
    taskId: record.taskId,
    runId: record.runId,
    name: record.name,
    title: record.title,
    description: record.description,
    phases: record.phases,
    summary: liveOutputSummary(record, status),
    scriptPath: record.scriptPath,
    transcriptDir: record.transcriptDir,
    outputPath: record.outputPath ?? record.errorPath,
    usage: record.usage,
    progress: structuredClone(record.progress),
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    recovery: { toolCall: { scriptPath: record.scriptPath, resumeFromRunId: record.runId, args: record.recovery?.args } },
  };
}

function launchOutputStatus(record: RunRecord): WorkflowLaunchOutput["status"] {
  if (record.status === "completed") return "completed";
  if (record.status === "failed" || record.status === "aborted" || record.status === "stale") return "failed";
  return "async_launched";
}

function liveOutputSummary(record: RunRecord, status: WorkflowLaunchOutput["status"]): string {
  if (status === "completed") return `Workflow ${record.name} completed (${record.progress.completed}/${record.progress.total} agents). Output: ${record.outputPath ?? record.runDir}`;
  if (status === "failed") return `Workflow ${record.name} ${record.status === "aborted" ? "aborted" : "failed"}. Artifacts: ${record.runDir}`;
  return `Workflow ${record.name} launched (${record.runId}). Artifacts: ${record.runDir}`;
}

function completedOutput(record: RunRecord, result: unknown): WorkflowLaunchOutput {
  return {
    status: "completed",
    taskId: record.taskId,
    runId: record.runId,
    name: record.name,
    title: record.title,
    description: record.description,
    phases: record.phases,
    summary: `Workflow ${record.name} completed (${record.progress.completed}/${record.progress.total} agents). Output: ${record.outputPath}`,
    scriptPath: record.scriptPath,
    transcriptDir: record.transcriptDir,
    outputPath: record.outputPath,
    resultPreview: truncateForChat(result, CHAT_PREVIEW_BYTES),
    usage: record.usage,
    progress: structuredClone(record.progress),
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    recovery: { toolCall: { scriptPath: record.scriptPath, resumeFromRunId: record.runId, args: record.recovery?.args } },
  };
}

function failedOutput(record: RunRecord, err: unknown): WorkflowLaunchOutput {
  const message = errorMessage(err);
  return {
    status: "failed",
    taskId: record.taskId,
    runId: record.runId,
    name: record.name,
    title: record.title,
    description: record.description,
    phases: record.phases,
    summary: `Workflow ${record.name} failed: ${message}. Artifacts: ${record.runDir}`,
    scriptPath: record.scriptPath,
    transcriptDir: record.transcriptDir,
    outputPath: record.errorPath,
    error: message,
    usage: record.usage,
    progress: structuredClone(record.progress),
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    recovery: { toolCall: { scriptPath: record.scriptPath, resumeFromRunId: record.runId, args: record.recovery?.args } },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function progressSummary(record: RunRecord): string {
  return `Workflow ${record.name}: ${record.progress.completed}/${record.progress.total} done, ${record.progress.running} running`;
}

function safeActiveTools(pi: ExtensionAPI): string[] {
  try {
    const tools = pi.getActiveTools?.();
    return Array.isArray(tools) ? tools : [];
  } catch {
    return [];
  }
}

function getModelRegistryModels(ctx: any): readonly ModelRegistryModelLike[] | undefined {
  try {
    const models = ctx?.modelRegistry?.getAll?.();
    return Array.isArray(models) ? (models as readonly ModelRegistryModelLike[]) : undefined;
  } catch {
    return undefined;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new WorkflowAbortError("Workflow aborted");
}

function throwIfShutdownAborted(record: RunRecord): void {
  if (record.status === "aborted") throw new WorkflowAbortError("Workflow aborted");
}

interface LinkedAbortSignal {
  signal: AbortSignal;
  cleanup(): void;
}

function linkAbortSignals(...signals: Array<AbortSignal | undefined>): LinkedAbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return { signal: new AbortController().signal, cleanup: () => undefined };
  if (active.length === 1) return { signal: active[0], cleanup: () => undefined };
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  const abortFrom = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason instanceof Error ? source.reason : new WorkflowAbortError("Workflow aborted"));
  };
  for (const signal of active) {
    if (signal.aborted) {
      abortFrom(signal);
      continue;
    }
    const listener = () => abortFrom(signal);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push(() => signal.removeEventListener("abort", listener));
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const remove of listeners.splice(0)) remove();
    },
  };
}

function clearStandardProgress(ctx: any, run: RunRecord): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui?.setWidget?.(standardProgressKey(run), undefined);
  } catch {
    // Ignore UI cleanup failures.
  }
}

function standardProgressKey(run: RunRecord): string {
  return `workflow:${run.runId}:__progress`;
}
