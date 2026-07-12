import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunRecord, WorkflowInput } from "../types.js";
import { RENDER_LIMITS, SCRIPT_MAX_BYTES, WORKFLOW_RESOURCE_LIMITS } from "../constants.js";
import { workflowFilePath } from "../persistence/paths.js";
import { registryRefreshOptions } from "../persistence/trust.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";
import type { RunStore } from "../persistence/run-store.js";
import type { WorkflowRegistry } from "../persistence/registry.js";
import { WorkflowRunner } from "../runtime/runner.js";
import { WorkflowManagerComponent, formatRunList } from "../ui/workflow-manager.js";
import { PagerComponent } from "../ui/simple-components.js";
import type { WorkflowActivation } from "../tool/workflow-activation.js";
import { slugify } from "../utils/ids.js";
import { sanitizeLine, sanitizeRenderedLine, truncateForChat } from "../utils/truncate.js";
import { parseWorkflowCommand, workflowHelpText, type WorkflowCommand } from "./workflow-command-parser.js";

export interface WorkflowCommandDeps {
  runStore: RunStore;
  registry: WorkflowRegistry;
  activation: WorkflowActivation;
}

const COMMAND_WIDGET_KEY = "workflow:command-preview";
const COMMAND_WIDGET_TTL_MS = 30_000;
const COMMAND_WIDGET_BODY_LINES = 8;
const commandWidgetTimers = new Map<string, { token: number; timer: NodeJS.Timeout; ui: any; widgetKey: string }>();
const commandWidgetSessionScopes = new Map<string, string>();
const commandWidgetUiScopes = new WeakMap<object, string>();
let commandWidgetNextScope = 0;
let commandWidgetNextToken = 0;

export function registerWorkflowCommand(pi: ExtensionAPI, deps: WorkflowCommandDeps): void {
  pi.registerCommand("workflow", {
    description: "Run, inspect, save, resume, control, and enable dynamic workflows",
    handler: async (rawArgs: string, ctx: any) => {
      try {
        const command = parseWorkflowCommand(rawArgs ?? "");
        await routeWorkflowCommand(pi, command, deps, ctx);
      } catch (err) {
        const message = (err as Error).message || String(err);
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        else console.error(message);
      }
    },
  } as any);
}

export async function routeWorkflowCommand(pi: ExtensionAPI, command: WorkflowCommand, deps: WorkflowCommandDeps, ctx: any): Promise<void> {
  switch (command.action) {
    case "enable":
      deps.activation.enable(ctx);
      return;
    case "disable":
      deps.activation.disable(ctx);
      return;
    case "toggle":
      deps.activation.toggle(ctx);
      return;
    case "status":
      deps.activation.report(ctx);
      return;
  }

  await deps.registry.refresh(ctx.cwd, registryRefreshOptions(ctx));
  await deps.runStore.refresh(ctx.cwd);
  switch (command.action) {
    case "manager":
      deps.activation.updateStatus(ctx);
      return openManager(deps, ctx);
    case "list":
      deps.activation.updateStatus(ctx);
      return printOrNotify(ctx, formatRunList(deps.runStore.list(command.filter, 100)));
    case "run":
      return runWorkflow(pi, deps, ctx, { ...targetToInput(command.target), args: command.args, mode: command.mode });
    case "resume":
      return resumeWorkflow(pi, deps, ctx, command.runId, command.scriptPath, command.args, command.mode);
    case "save":
      return saveWorkflow(deps, ctx, command.runId, command.scope, command.name);
    case "pause":
    case "continue":
    case "stop":
      return controlRun(deps, ctx, command.action, command.runId);
    case "skip-agent":
      return skipAgent(deps, ctx, command.runId, command.callId);
    case "open":
      return openArtifact(deps, ctx, command.runId, command.target);
    case "delete":
      return deleteRun(deps, ctx, command.runId);
  }
}

async function openManager(deps: WorkflowCommandDeps, ctx: any): Promise<void> {
  const runs = deps.runStore.list("all", RENDER_LIMITS.managerRows);
  if (!ctx.hasUI) return printOrNotify(ctx, formatRunList(runs));
  const component = new WorkflowManagerComponent(runs, ctx.ui.theme);
  showCommandWidget(ctx, "Workflow runs", component.render(100).slice(3));
}

async function runWorkflow(pi: ExtensionAPI, deps: WorkflowCommandDeps, ctx: any, input: WorkflowInput): Promise<void> {
  const runner = new WorkflowRunner({ pi, runStore: deps.runStore, registry: deps.registry });
  const result = await runner.launchOrRun({ toolCallId: `cmd_${Date.now().toString(36)}`, input, ctx });
  await printOrNotify(ctx, result.summary);
}

async function resumeWorkflow(pi: ExtensionAPI, deps: WorkflowCommandDeps, ctx: any, runId: string, scriptPath?: string, args?: Record<string, unknown>, mode?: "await" | "async"): Promise<void> {
  const run = requireRun(deps.runStore.get(runId), runId);
  const loadedArgs = args ?? (await readJsonMaybe(run.argsPath, WORKFLOW_RESOURCE_LIMITS.runArgsBytes)) ?? {};
  await runWorkflow(pi, deps, ctx, { scriptPath: scriptPath ?? run.scriptPath, args: loadedArgs, resumeFromRunId: runId, mode });
}

async function saveWorkflow(deps: WorkflowCommandDeps, ctx: any, runId: string, scope: "project" | "user", name?: string): Promise<void> {
  const run = requireRun(deps.runStore.get(runId), runId);
  const target = workflowFilePath(scope, ctx.cwd, slugify(name ?? run.name));
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.promises.copyFile(run.scriptPath, target, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Workflow file already exists: ${target}`);
    throw err;
  }
  await deps.registry.refresh(ctx.cwd, registryRefreshOptions(ctx));
  await printOrNotify(ctx, `Saved workflow ${run.name} to ${target}`);
}

async function controlRun(deps: WorkflowCommandDeps, ctx: any, action: "pause" | "continue" | "stop", runId: string): Promise<void> {
  const run = requireRun(deps.runStore.get(runId), runId);
  const control = deps.runStore.getControl(runId);
  if (!control) return printOrNotify(ctx, `Run ${runId} is not live (status: ${run.status})`);
  if (action === "pause") {
    control.pause();
    await deps.runStore.setStatus(runId, "paused");
  } else if (action === "continue") {
    control.resume();
    await deps.runStore.setStatus(runId, "running");
  } else control.stop("stopped by /workflow stop");
  await printOrNotify(ctx, `${action} sent to ${runId}`);
}

async function skipAgent(deps: WorkflowCommandDeps, ctx: any, runId: string, callId: string): Promise<void> {
  const control = deps.runStore.getControl(runId);
  if (!control) return printOrNotify(ctx, `Run ${runId} is not live`);
  const ok = control.skipAgent(callId);
  await printOrNotify(ctx, ok ? `skip-agent sent to ${callId}` : `skip-agent could not be applied to ${callId}`);
}

async function openArtifact(deps: WorkflowCommandDeps, ctx: any, runId: string, target: "result" | "script" | "journal" | "transcripts"): Promise<void> {
  const run = requireRun(deps.runStore.get(runId), runId);
  const file = artifactPath(run, target);
  const text = target === "transcripts" ? await listTranscripts(run) : await readBoundedTextFile(file, artifactReadLimit(target, file));
  if (ctx.hasUI) showCommandWidget(ctx, `${runId} ${target}`, new PagerComponent(`${runId} ${target}`, text.split("\n")).render(100).slice(2), `Artifact: ${file}`);
  else console.log(truncateForChat(text, 50_000));
}

function showCommandWidget(ctx: any, title: string, lines: string[], footer?: string): void {
  const body = lines.length > 0 ? lines : ["(empty)"];
  const bodyLimit = footer ? COMMAND_WIDGET_BODY_LINES - 1 : COMMAND_WIDGET_BODY_LINES;
  const visible = body.slice(0, bodyLimit);
  if (body.length > visible.length) visible.push(`… ${body.length - visible.length} more line(s)`);
  if (footer) visible.push(footer);
  const safeTitle = sanitizeLine(title, 500);
  const widgetKey = commandWidgetKey(ctx);
  const previous = commandWidgetTimers.get(widgetKey);
  if (previous) {
    clearTimeout(previous.timer);
    if (previous.ui !== ctx.ui) clearCommandWidget(previous.ui, previous.widgetKey);
  }
  ctx.ui.setWidget(widgetKey, [`◆ ${safeTitle}`, ...visible.map((line) => sanitizeRenderedLine(line, 4000))], { placement: "aboveEditor" });
  ctx.ui.notify(`${safeTitle} preview shown above the editor for ${COMMAND_WIDGET_TTL_MS / 1000}s. No keys captured.`, "info");
  const token = ++commandWidgetNextToken;
  const timer = setTimeout(() => {
    const current = commandWidgetTimers.get(widgetKey);
    if (!current || current.token !== token) return;
    clearCommandWidget(current.ui, current.widgetKey);
    commandWidgetTimers.delete(widgetKey);
  }, COMMAND_WIDGET_TTL_MS);
  timer.unref?.();
  commandWidgetTimers.set(widgetKey, { token, timer, ui: ctx.ui, widgetKey });
}

function commandWidgetKey(ctx: any): string {
  return `${COMMAND_WIDGET_KEY}:${commandWidgetScope(ctx)}`;
}

function commandWidgetScope(ctx: any): string {
  const sessionId = ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionManager?.getHeader?.()?.id;
  if (typeof sessionId === "string" && sessionId.trim()) {
    const trimmed = sessionId.trim();
    let scope = commandWidgetSessionScopes.get(trimmed);
    if (!scope) {
      scope = `session:${++commandWidgetNextScope}`;
      commandWidgetSessionScopes.set(trimmed, scope);
    }
    return scope;
  }

  const ui = ctx?.ui;
  if (ui && (typeof ui === "object" || typeof ui === "function")) {
    const key = ui as object;
    let scope = commandWidgetUiScopes.get(key);
    if (!scope) {
      scope = `ui:${++commandWidgetNextScope}`;
      commandWidgetUiScopes.set(key, scope);
    }
    return scope;
  }

  return "global";
}

function clearCommandWidget(ui: any, widgetKey: string): void {
  try {
    ui?.setWidget?.(widgetKey, undefined);
  } catch {
    // Timer cleanup is best-effort; command output should not crash the host UI loop.
  }
}

async function deleteRun(deps: WorkflowCommandDeps, ctx: any, runId: string): Promise<void> {
  requireRun(deps.runStore.get(runId), runId);
  await deps.runStore.delete(runId);
  await printOrNotify(ctx, `Deleted ${runId}`);
}

function targetToInput(target: string): Pick<WorkflowInput, "name" | "scriptPath"> {
  return target.endsWith(".js") || target.startsWith(".") || target.startsWith("/") || target.includes(path.sep) ? { scriptPath: target } : { name: target };
}

function artifactPath(run: RunRecord, target: "result" | "script" | "journal" | "transcripts"): string {
  if (target === "script") return run.scriptPath;
  if (target === "journal") return run.journalPath;
  if (target === "transcripts") return run.transcriptDir;
  return run.outputPath ?? run.errorPath ?? path.join(run.runDir, "run.json");
}

function artifactReadLimit(target: "result" | "script" | "journal", filePath: string): number {
  if (target === "journal") return WORKFLOW_RESOURCE_LIMITS.journalBytes;
  if (target === "script") return SCRIPT_MAX_BYTES;
  if (path.basename(filePath) === "run.json") return WORKFLOW_RESOURCE_LIMITS.runRecordBytes;
  return WORKFLOW_RESOURCE_LIMITS.workflowOutputBytes;
}

async function listTranscripts(run: RunRecord): Promise<string> {
  const entries = await fs.promises.readdir(run.transcriptDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e: any) => e.isDirectory()).map((e: any) => path.join(run.transcriptDir, e.name)).join("\n") || "No subagent transcripts.";
}

function requireRun(run: RunRecord | undefined, runId: string): RunRecord {
  if (!run) throw new Error(`Unknown workflow run: ${runId}`);
  return run;
}

async function printOrNotify(ctx: any, text: string): Promise<void> {
  if (ctx.hasUI) ctx.ui.notify(text, "info");
  else console.log(text || workflowHelpText());
}

async function readJsonMaybe(filePath: string, maxBytes: number): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readBoundedTextFile(filePath, maxBytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Workflow args file must contain a JSON object: ${filePath}`);
    return parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}
