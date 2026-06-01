import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunRecord, WorkflowInput, WorkflowViewSnapshot } from "../types.js";
import { RENDER_LIMITS } from "../constants.js";
import { workflowFilePath } from "../persistence/paths.js";
import type { RunStore } from "../persistence/run-store.js";
import type { WorkflowRegistry } from "../persistence/registry.js";
import { WorkflowRunner } from "../runtime/runner.js";
import { loadViewSnapshot } from "../ui/workflow-view-store.js";
import { WorkflowViewRenderer } from "../ui/workflow-view-renderer.js";
import { WorkflowViewComponent } from "../ui/workflow-view-widget.js";
import { normalizeDashboardDocument } from "../ui/dashboard.js";
import { WorkflowManagerComponent, formatRunList } from "../ui/workflow-manager.js";
import { PagerComponent } from "../ui/simple-components.js";
import type { WorkflowActivation } from "../tool/workflow-activation.js";
import { slugify } from "../utils/ids.js";
import { sanitizeLine, sanitizeRenderedLine, truncateForChat } from "../utils/truncate.js";
import { parseWorkflowCommand, workflowHelpText, type WorkflowCommand, type WorkflowOpenProfile } from "./workflow-command-parser.js";

export interface WorkflowCommandDeps {
  runStore: RunStore;
  registry: WorkflowRegistry;
  renderer: WorkflowViewRenderer;
  activation: WorkflowActivation;
}

const COMMAND_WIDGET_KEY = "workflow:command-preview";
const COMMAND_WIDGET_TTL_MS = 30_000;
const COMMAND_WIDGET_BODY_LINES = 8;
const commandWidgetTimers = new Map<string, NodeJS.Timeout>();

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

  if (command.action === "preview-ui") return previewUi(deps, ctx, command.json, command.profile, command.width);

  await deps.registry.refresh(ctx.cwd);
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
      return openArtifact(deps, ctx, command.runId, command.target, command.viewId, command.profile, command.width);
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
  const runner = new WorkflowRunner({ pi, runStore: deps.runStore, registry: deps.registry, renderer: deps.renderer });
  const result = await runner.launchOrRun({ toolCallId: `cmd_${Date.now().toString(36)}`, input, ctx });
  await printOrNotify(ctx, result.summary);
}

async function resumeWorkflow(pi: ExtensionAPI, deps: WorkflowCommandDeps, ctx: any, runId: string, scriptPath?: string, args?: Record<string, unknown>, mode?: "await" | "async"): Promise<void> {
  const run = requireRun(deps.runStore.get(runId), runId);
  const loadedArgs = args ?? (await readJsonMaybe(run.argsPath)) ?? {};
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
  await deps.registry.refresh(ctx.cwd);
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

async function openArtifact(deps: WorkflowCommandDeps, ctx: any, runId: string, target: "result" | "script" | "journal" | "transcripts" | "ui", viewId?: string, profile?: WorkflowOpenProfile, width?: number): Promise<void> {
  const run = requireRun(deps.runStore.get(runId), runId);
  if (target === "ui") {
    const snapshot = await loadViewSnapshot(run, viewId);
    if (!snapshot) return printOrNotify(ctx, viewId ? `Run ${runId} has no UI view ${viewId}` : `Run ${runId} has no UI views`);
    await openUiSnapshot(deps, ctx, `${runId} ui${viewId ? `/${viewId}` : ""}`, snapshot, profile ?? "full", width);
    return;
  }
  const file = artifactPath(run, target);
  const text = target === "transcripts" ? await listTranscripts(run) : await fs.promises.readFile(file, "utf8");
  if (ctx.hasUI) showCommandWidget(ctx, `${runId} ${target}`, new PagerComponent(`${runId} ${target}`, text.split("\n")).render(100).slice(2), `Artifact: ${file}`);
  else console.log(truncateForChat(text, 50_000));
}

async function previewUi(deps: WorkflowCommandDeps, ctx: any, json: string, profile: WorkflowOpenProfile = "panel", width?: number): Promise<void> {
  const state = normalizeDashboardDocument(JSON.parse(json) as unknown);
  const snapshot: WorkflowViewSnapshot = {
    seq: 0,
    spec: {
      version: 1,
      id: "preview",
      title: typeof state.title === "string" && state.title.trim() ? state.title.trim().slice(0, 120) : "Dashboard preview",
      initialState: state,
      layout: { type: "dashboard" },
    },
    state,
  };
  await openUiSnapshot(deps, ctx, "dashboard preview", snapshot, profile, width);
}

async function openUiSnapshot(deps: WorkflowCommandDeps, ctx: any, title: string, snapshot: WorkflowViewSnapshot, profile: WorkflowOpenProfile, width?: number): Promise<void> {
  if (width !== undefined) {
    const lines = deps.renderer.render(snapshot, width, profile);
    if (ctx.hasUI) return showCommandWidget(ctx, title, lines);
    console.log(lines.join("\n"));
    return;
  }

  if (ctx.hasUI) {
    const component = new WorkflowViewComponent(snapshot, deps.renderer, profile);
    showCommandWidget(ctx, title, component.render(100));
  } else if (profile === "full") console.log(deps.renderer.renderMarkdown(snapshot));
  else console.log(deps.renderer.render(snapshot, 100, profile).join("\n"));
}

function showCommandWidget(ctx: any, title: string, lines: string[], footer?: string): void {
  const body = lines.length > 0 ? lines : ["(empty)"];
  const bodyLimit = footer ? COMMAND_WIDGET_BODY_LINES - 1 : COMMAND_WIDGET_BODY_LINES;
  const visible = body.slice(0, bodyLimit);
  if (body.length > visible.length) visible.push(`… ${body.length - visible.length} more line(s)`);
  if (footer) visible.push(footer);
  const safeTitle = sanitizeLine(title, 500);
  ctx.ui.setWidget(COMMAND_WIDGET_KEY, [`◆ ${safeTitle}`, ...visible.map((line) => sanitizeRenderedLine(line, 4000))], { placement: "aboveEditor" });
  ctx.ui.notify(`${safeTitle} preview shown above the editor for ${COMMAND_WIDGET_TTL_MS / 1000}s. No keys captured.`, "info");
  const previous = commandWidgetTimers.get(COMMAND_WIDGET_KEY);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    ctx.ui?.setWidget?.(COMMAND_WIDGET_KEY, undefined);
    commandWidgetTimers.delete(COMMAND_WIDGET_KEY);
  }, COMMAND_WIDGET_TTL_MS);
  timer.unref?.();
  commandWidgetTimers.set(COMMAND_WIDGET_KEY, timer);
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

async function readJsonMaybe(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
