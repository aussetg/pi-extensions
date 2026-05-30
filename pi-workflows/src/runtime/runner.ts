import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunRecord, ToolResult, WorkflowInput, WorkflowLaunchOutput, WorkflowViewPlacement, WorkflowViewSnapshot } from "../types.js";
import { CHAT_PREVIEW_BYTES, DEFAULT_LIMITS, WORKFLOW_RESULT_MESSAGE } from "../constants.js";
import { WorkflowRegistry } from "../persistence/registry.js";
import { RunStore } from "../persistence/run-store.js";
import { JsonlJournal, ResumeIndex } from "../persistence/journal.js";
import { resolveLocalPath } from "../persistence/paths.js";
import { parseWorkflowScript, type ParsedWorkflowScript } from "./parser.js";
import { WorkflowBudget } from "./budget.js";
import { RunControl } from "./run-control.js";
import { WorkflowScheduler } from "./scheduler.js";
import { executeWorkflowSandbox } from "./sandbox.js";
import { createWorkflowUiGlobal } from "./ui-global.js";
import { WorkflowViewStore, workflowViewPlacement } from "../ui/workflow-view-store.js";
import { WorkflowViewComponent } from "../ui/workflow-view-widget.js";
import { WorkflowViewRenderer, type WorkflowViewRenderProfile } from "../ui/workflow-view-renderer.js";
import { WorkflowProgressComponent } from "../ui/workflow-result-component.js";
import { nowIso } from "../utils/ids.js";
import { truncateForChat } from "../utils/truncate.js";
import { toStableJsonValue } from "../utils/stable-json.js";
import { WorkflowAbortError } from "./errors.js";

export interface WorkflowRunnerDeps {
  pi: ExtensionAPI;
  runStore: RunStore;
  registry: WorkflowRegistry;
  renderer?: WorkflowViewRenderer;
  childDepth?: number;
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
  private readonly renderer: WorkflowViewRenderer;

  constructor(private readonly deps: WorkflowRunnerDeps) {
    this.renderer = deps.renderer ?? new WorkflowViewRenderer();
  }

  async launchOrRun(args: LaunchArgs): Promise<WorkflowLaunchOutput> {
    validateInput(args.input);
    const ctx = args.ctx;
    await this.deps.registry.refresh(ctx.cwd);
    await this.deps.runStore.refresh(ctx.cwd);
    const resolved = await this.resolveSource(args.input, ctx.cwd);
    const stableArgs = (args.input.args ? toStableJsonValue(args.input.args) : {}) as Record<string, unknown>;

    if (args.input.resumeFromRunId) {
      const source = this.deps.runStore.get(args.input.resumeFromRunId);
      if (source?.status === "running" || source?.status === "paused") throw new Error(`Cannot resume from running workflow ${args.input.resumeFromRunId}; stop it first.`);
    }

    const sessionId = ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager?.getHeader?.()?.id ?? "unknown-session";
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
    const execute = (onUpdate: LaunchArgs["onUpdate"] | undefined) => this.executeRun({ record, resolved, stableArgs, input: args.input, ctx, control, onUpdate });

    if (mode === "async") {
      const donePromise = Promise.resolve()
        .then(() => execute(undefined))
        .then((result) => {
          if (this.deps.runStore.shouldNotifyOnComplete(record.runId)) this.sendCompletion(ctx, result);
        })
        .catch((err) => {
          if (this.deps.runStore.shouldNotifyOnComplete(record.runId)) this.sendCompletion(ctx, failedOutput(record, err));
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

  private async executeRun(args: { record: RunRecord; resolved: ResolvedWorkflowSource; stableArgs: Record<string, unknown>; input: WorkflowInput; ctx: any; control: RunControl; onUpdate?: LaunchArgs["onUpdate"] }): Promise<WorkflowLaunchOutput> {
    const { record, resolved, stableArgs, input, ctx, control } = args;
    const journal = new JsonlJournal(record.journalPath);
    await journal.append({ type: "workflow_started", runId: record.runId, time: nowIso(), scriptHash: record.scriptHash, argsHash: record.argsHash });
    let resumeIndex: ResumeIndex | undefined;
    if (input.resumeFromRunId) {
      const source = this.deps.runStore.get(input.resumeFromRunId);
      if (source) resumeIndex = await ResumeIndex.fromRun(source.runDir, source.journalPath);
    }

    const viewComponents = new Map<string, WorkflowViewComponent>();
    let progressComponent: WorkflowProgressComponent | undefined;
    const showStandardProgress = !!ctx.hasUI && !args.onUpdate;
    const updateStandardProgress = () => {
      if (!showStandardProgress) return;
      try {
        ctx.ui?.setWidget?.(standardProgressKey(record), (_tui: any, theme: any) => {
          if (!progressComponent) progressComponent = new WorkflowProgressComponent(() => asyncOutput(record), theme);
          else progressComponent.invalidate();
          return progressComponent;
        }, { placement: "belowEditor" });
      } catch {
        // Standard live progress is best-effort; artifacts and completion messages remain authoritative.
      }
    };
    let viewStore!: WorkflowViewStore;
    const emitProgress = () => {
      updateStandardProgress();
      try {
        args.onUpdate?.({ content: [{ type: "text", text: progressSummary(record) }], details: { ...asyncOutput(record), progress: record.progress, uiViews: outputViews(viewStore, ["runPanel"]) } as WorkflowLaunchOutput & { progress: unknown } });
      } catch {
        // Progress rendering is best-effort; it should never change workflow semantics.
      }
    };
    viewStore = new WorkflowViewStore(record, journal, this.deps.runStore, (_viewId, snapshot) => {
      if (ctx.hasUI) updateLiveView(ctx, record, snapshot, this.renderer, viewComponents);
      if (workflowViewPlacement(snapshot) === "runPanel") emitProgress();
    }, (_viewId, snapshot) => {
      if (ctx.hasUI) clearLiveView(ctx, record, snapshot);
      if (workflowViewPlacement(snapshot) === "runPanel") emitProgress();
    });
    updateStandardProgress();
    const ui = createWorkflowUiGlobal(viewStore);
    const budget = new WorkflowBudget(input.budgetTokens ?? null);
    const scheduler = new WorkflowScheduler({
      cwd: ctx.cwd,
      run: record,
      journal,
      control,
      budget,
      resumeIndex,
      maxAgents: Math.min(input.maxAgents ?? DEFAULT_LIMITS.agentCap, DEFAULT_LIMITS.agentCap),
      activeTools: safeActiveTools(this.deps.pi),
      persist: () => this.deps.runStore.scheduleSave(record),
      onProgress: emitProgress,
    });

    const globals = {
      agent: (prompt: unknown, opts?: unknown) => scheduler.agentCall(prompt, (opts ?? {}) as any),
      phase: (title: string) => scheduler.phase(title),
      log: (message: string) => scheduler.log(message),
      workflow: async (nameOrRef: unknown, childArgs?: unknown) => {
        if ((this.deps.childDepth ?? 0) >= 1) throw new Error("Nested child workflows are limited to one level");
        const childInput = childWorkflowInput(nameOrRef, childArgs);
        const child = new WorkflowRunner({ ...this.deps, childDepth: (this.deps.childDepth ?? 0) + 1 });
        const output = await child.launchOrRun({ toolCallId: `${record.taskId}_child`, input: childInput, signal: control.signal, ctx });
        if (output.status === "failed") throw new Error(output.error ?? `Child workflow ${output.name} failed`);
        if (!output.outputPath) return output;
        const parsed = JSON.parse(await fs.promises.readFile(output.outputPath, "utf8")) as { result?: unknown };
        return parsed.result ?? null;
      },
      ui,
      args: stableArgs,
      budget,
      cwd: ctx.cwd,
    };

    try {
      const result = await executeWorkflowSandbox(resolved.parsed.executableSource, globals, control.signal);
      record.status = "completed";
      record.endedAt = nowIso();
      if (typeof (ui as any).__flush === "function") await (ui as any).__flush();
      const outputPath = path.join(record.runDir, "output.json");
      await fs.promises.writeFile(outputPath, `${JSON.stringify({ result }, null, 2)}\n`, "utf8");
      await this.deps.runStore.flush(record.runId);
      record.outputPath = outputPath;
      await journal.append({ type: "workflow_completed", runId: record.runId, time: nowIso(), outputPath, usage: record.usage });
      await this.deps.runStore.saveNow(record);
      const output = completedOutput(record, result, outputViews(viewStore, ["runPanel", "completion"]));
      if (showStandardProgress) clearStandardProgress(ctx, record);
      clearLiveViews(ctx, record, viewStore);
      return output;
    } catch (err) {
      if (!(err instanceof WorkflowAbortError)) control.stop("workflow failed");
      const error = err instanceof WorkflowAbortError ? "Workflow aborted" : (err as Error).message;
      record.status = err instanceof WorkflowAbortError ? "aborted" : "failed";
      record.endedAt = nowIso();
      if (typeof (ui as any).__flush === "function") await (ui as any).__flush().catch(() => undefined);
      const errorPath = path.join(record.runDir, "error.json");
      await fs.promises.writeFile(errorPath, `${JSON.stringify({ error, stack: (err as Error).stack }, null, 2)}\n`, "utf8");
      await this.deps.runStore.flush(record.runId);
      record.errorPath = errorPath;
      await journal.append({ type: "workflow_failed", runId: record.runId, time: nowIso(), error, errorPath });
      await this.deps.runStore.saveNow(record);
      const output = failedOutput(record, err, outputViews(viewStore, ["runPanel", "completion"]));
      if (showStandardProgress) clearStandardProgress(ctx, record);
      clearLiveViews(ctx, record, viewStore);
      return output;
    }
  }

  private async resolveSource(input: WorkflowInput, cwd: string): Promise<ResolvedWorkflowSource> {
    let source: string;
    let originalPath: string | undefined;
    if (input.scriptPath) {
      originalPath = resolveLocalPath(cwd, input.scriptPath);
      source = await fs.promises.readFile(originalPath, "utf8");
    } else if (input.name) {
      const ref = this.deps.registry.get(input.name);
      if (!ref) throw new Error(`Unknown workflow: ${input.name}`);
      originalPath = ref.path;
      source = await fs.promises.readFile(ref.path, "utf8");
    } else {
      source = input.script!;
    }
    return { source, originalPath, parsed: parseWorkflowScript(source) };
  }

  private sendCompletion(ctx: any, result: WorkflowLaunchOutput): void {
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
  const childArgs = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined;
  if (typeof nameOrRef === "string") return { name: nameOrRef, args: childArgs, mode: "await" };
  if (nameOrRef && typeof nameOrRef === "object" && typeof (nameOrRef as any).scriptPath === "string") {
    return { scriptPath: (nameOrRef as any).scriptPath, args: childArgs, mode: "await" };
  }
  throw new Error("workflow(nameOrRef, args?) expects a workflow name string or { scriptPath }");
}

function validateInput(input: WorkflowInput): void {
  if (!input || typeof input !== "object") throw new Error("workflow input must be an object");
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
  if (input.args !== undefined) toStableJsonValue(input.args);
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

function completedOutput(record: RunRecord, result: unknown, uiViews?: WorkflowViewSnapshot[]): WorkflowLaunchOutput {
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
    uiViews,
    recovery: { toolCall: { scriptPath: record.scriptPath, resumeFromRunId: record.runId, args: record.recovery?.args } },
  };
}

function failedOutput(record: RunRecord, err: unknown, uiViews?: WorkflowViewSnapshot[]): WorkflowLaunchOutput {
  const message = (err as Error).message ?? String(err);
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
    uiViews,
    recovery: { toolCall: { scriptPath: record.scriptPath, resumeFromRunId: record.runId, args: record.recovery?.args } },
  };
}

function progressSummary(record: RunRecord): string {
  return `Workflow ${record.name}: ${record.progress.completed}/${record.progress.total} done, ${record.progress.running} running`;
}

function safeActiveTools(pi: ExtensionAPI): string[] | undefined {
  try {
    return pi.getActiveTools?.();
  } catch {
    return undefined;
  }
}

function outputViews(store: WorkflowViewStore, placements: WorkflowViewPlacement[]): WorkflowViewSnapshot[] | undefined {
  const views = store.listByPlacement(...placements).map((snapshot) => structuredClone(snapshot) as WorkflowViewSnapshot);
  return views.length > 0 ? views : undefined;
}

function updateLiveView(ctx: any, run: RunRecord, snapshot: WorkflowViewSnapshot, renderer: WorkflowViewRenderer, components: Map<string, WorkflowViewComponent>): void {
  const placement = workflowViewPlacement(snapshot);
  if (placement !== "widget" && placement !== "runPanel") return;
  const key = liveViewKey(run, snapshot);
  let component = components.get(snapshot.spec.id);
  const profile = liveViewProfile(snapshot);
  if (!component) {
    component = new WorkflowViewComponent(snapshot, renderer, profile);
    components.set(snapshot.spec.id, component);
  } else component.update(snapshot);
  try {
    ctx.ui?.setWidget?.(key, () => component, { placement: placement === "runPanel" ? "belowEditor" : "aboveEditor" });
  } catch {
    // UI delivery is best-effort; artifacts and final details still carry the view.
  }
}

function liveViewProfile(snapshot: WorkflowViewSnapshot): Extract<WorkflowViewRenderProfile, "compact" | "panel"> {
  const placement = workflowViewPlacement(snapshot);
  return placement === "widget" || snapshot.spec.defaultExpanded === false ? "compact" : "panel";
}

function clearLiveViews(ctx: any, run: RunRecord, store: WorkflowViewStore): void {
  if (!ctx.hasUI) return;
  for (const snapshot of store.listByPlacement("runPanel", "widget")) {
    clearLiveView(ctx, run, snapshot);
  }
}

function clearLiveView(ctx: any, run: RunRecord, snapshot: WorkflowViewSnapshot): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui?.setWidget?.(liveViewKey(run, snapshot), undefined);
  } catch {
    // Ignore UI cleanup failures.
  }
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

function liveViewKey(run: RunRecord, snapshot: WorkflowViewSnapshot): string {
  return `workflow:${run.runId}:${snapshot.spec.id}`;
}
