import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SdkAgentWorkerExecutor } from "../agents/sdk-executor.js";
import { SandboxedCommandExecutor } from "../commands/executor.js";
import { HostMeasurementEnvironmentProvider, type MeasurementEnvironmentDescriptor } from "../measurements/environment.js";
import { WorkflowRunCatalog, workflowShortRunIds, type WorkflowRunCatalogEntry } from "../persistence/run-catalog.js";
import { WorkflowRunDatabase, WorkflowRunDatabaseReader } from "../persistence/run-database.js";
import {
  createWorkflowInvocationSnapshot,
  readWorkflowInvocationSnapshot,
  writeWorkflowInvocationSnapshot,
} from "../persistence/workflow-invocation.js";
import { readWorkflowInspectorPage } from "../projection/inspector-pages.js";
import { readWorkflowRunProjection } from "../projection/run-projection.js";
import type { WorkflowInspectorPageKind, WorkflowRunProjection } from "../projection/types.js";
import { projectRoot } from "../persistence/paths.js";
import { WorkflowRegistry } from "../registry/structured-workflows.js";
import type { JsonObject, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import {
  assertProjectSnapshotManifest,
  captureProjectSnapshot,
  type ProjectSnapshotManifest,
} from "../workspaces/project-snapshot.js";
import { coordinatorUnitName } from "./coordinator-identity.js";
import { WorkflowCoordinatorAlreadyRunningError, WorkflowCoordinatorService } from "./coordinator-service.js";
import type { WorkflowNamedClient, WorkflowNamedResult, WorkflowRunSummary } from "./named-workflow-types.js";
import { prepareWorkflowResources } from "./prepare-resources.js";
import { WorkflowControlClient } from "./workflow-control-client.js";

const SETTLED = new Set(["waiting", "paused", "completed", "failed", "stopped"]);
const TERMINAL = new Set(["completed", "failed", "stopped"]);
const COORDINATOR_PROBE_MS = 1_000;

interface WorkflowLaunchBinding {
  mode: "await" | "async";
  sessionId: string;
  projectRoot: string;
}

export class WorkflowNamedService implements WorkflowNamedClient {
  readonly registry: WorkflowRegistry;
  readonly catalog: WorkflowRunCatalog;
  readonly coordinator: WorkflowCoordinatorService;
  readonly controls: WorkflowControlClient;
  readonly agentExecutorDescriptor = new SdkAgentWorkerExecutor().describe();
  private readonly commandExecutorDescriptor = new SandboxedCommandExecutor().describe();
  private readonly measurementEnvironmentDescriptor: MeasurementEnvironmentDescriptor = new HostMeasurementEnvironmentProvider().describe();
  private context?: ExtensionContext;
  private readonly listeners = new Set<(projection: WorkflowRunProjection) => void>();
  private readonly watchers = new Map<string, NodeJS.Timeout>();
  private readonly notified = new Set<string>();

  constructor(private readonly pi: ExtensionAPI, options: {
    registry?: WorkflowRegistry;
    catalog?: WorkflowRunCatalog;
    coordinator?: WorkflowCoordinatorService;
  } = {}) {
    this.registry = options.registry ?? new WorkflowRegistry();
    this.catalog = options.catalog ?? new WorkflowRunCatalog();
    this.coordinator = options.coordinator ?? new WorkflowCoordinatorService();
    this.controls = new WorkflowControlClient(this.catalog, this.coordinator);
  }

  bindContext(ctx: ExtensionContext): void {
    if (this.context && (
      sessionId(this.context) !== sessionId(ctx)
      || path.resolve(projectRoot(this.context.cwd)) !== path.resolve(projectRoot(ctx.cwd))
    )) this.clearWatchers();
    this.context = ctx;
  }
  detachContext(): void { for (const timer of this.watchers.values()) clearTimeout(timer); this.watchers.clear(); this.context = undefined; }
  subscribeProjection(listener: (projection: WorkflowRunProjection) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }

  async refreshDefinitions(ctx: ExtensionContext): Promise<void> {
    await this.registry.refresh(ctx.cwd, { includeProject: ctx.isProjectTrusted() });
  }

  async invoke(
    input: { name: string; args: JsonObject; mode: "await" | "async" },
    authority: "model" | "user" | "rpc",
    ctx: ExtensionContext,
    options: { onUpdate?: (summary: WorkflowRunSummary) => void | Promise<void> } = {},
  ): Promise<WorkflowNamedResult> {
    this.assertPrimary(ctx);
    validateMode(input.mode, ctx.mode);
    await this.refreshDefinitions(ctx);
    const ref = this.registry.resolve(input.name);
    const launched = await this.launch(ref.id, input.args, authority, input.mode, ctx);
    if (input.mode === "async") {
      this.watch(launched, launched.binding);
      return await this.result(launched);
    }
    const settled = await this.awaitSettled(launched, ctx.signal, options.onUpdate);
    return await this.result({ ...launched, run: settled });
  }

  async replay(
    input: { sourceRunRef: string; args?: JsonObject; mode: "await" | "async"; fresh: boolean },
    authority: "model" | "user" | "rpc",
    ctx: ExtensionContext,
  ): Promise<WorkflowNamedResult> {
    this.assertPrimary(ctx);
    validateMode(input.mode, ctx.mode);
    const source = await this.catalog.resolve(input.sourceRunRef);
    if (!source.run) throw new Error(source.error ?? "Replay source is unavailable");
    const sourceSnapshot = await readWorkflowInvocationSnapshot(source.paths.root);
    await assertReplayProject(source.paths.projectManifest, ctx.cwd);
    await this.refreshDefinitions(ctx);
    const ref = this.registry.resolve(sourceSnapshot.workflowId);
    const launched = await this.launch(
      ref.id,
      input.args ?? sourceSnapshot.input,
      authority,
      input.mode,
      ctx,
      { sourceRunId: source.runId, sourceRunDir: source.paths.root, fresh: input.fresh },
    );
    if (input.mode === "async") { this.watch(launched, launched.binding); return await this.result(launched); }
    const settled = await this.awaitSettled(launched, ctx.signal);
    return await this.result({ ...launched, run: settled });
  }

  async list(_ctx: ExtensionContext): Promise<WorkflowRunSummary[]> {
    const entries = await this.catalog.list();
    const short = workflowShortRunIds(entries.map(entry => entry.runId));
    return entries.map(entry => entry.run ? summary(entry.run, short.get(entry.runId)) : corruptSummary(entry, short.get(entry.runId)));
  }

  async open(runRef: string, _ctx: ExtensionContext): Promise<WorkflowRunProjection> {
    const entry = await this.catalog.resolve(runRef);
    const [snapshot, short] = await Promise.all([
      readWorkflowInvocationSnapshot(entry.paths.root), this.shortId(entry.runId),
    ]);
    const reader = WorkflowRunDatabaseReader.open(entry.paths.database);
    try { return readWorkflowRunProjection(reader, snapshot, { shortRunId: short }); }
    finally { reader.close(); }
  }

  async inspectPage(runRef: string, kind: WorkflowInspectorPageKind, options: { cursor?: string; limit?: number }, _ctx: ExtensionContext) {
    const entry = await this.catalog.resolve(runRef);
    const reader = WorkflowRunDatabaseReader.open(entry.paths.database);
    try { return readWorkflowInspectorPage(reader, kind, options); } finally { reader.close(); }
  }

  pause(runRef: string, ctx: ExtensionContext) { this.assertPrimary(ctx); return this.controls.pause(runRef, ctx); }
  resume(runRef: string, ctx: ExtensionContext) { this.assertPrimary(ctx); return this.controls.resume(runRef, ctx); }
  stop(runRef: string, ctx: ExtensionContext) { this.assertPrimary(ctx); return this.controls.stop(runRef, ctx); }
  stopEffect(runRef: string, operationRef: string, ctx: ExtensionContext) { this.assertPrimary(ctx); return this.controls.stopEffect(runRef, operationRef, ctx); }
  humanChallenge(runRef: string, kind: "ask" | "apply", ctx: ExtensionContext) { this.assertPrimary(ctx); return this.controls.humanChallenge(runRef, kind, ctx); }
  respond(runRef: string, interactionId: string | undefined, challenge: string, value: JsonValue, ctx: ExtensionContext) {
    this.assertPrimary(ctx); return this.controls.respond(runRef, interactionId, challenge, value, ctx);
  }
  decideApproval(runRef: string, decision: "approve" | "reject", challenge: string, ctx: ExtensionContext) {
    this.assertPrimary(ctx); return this.controls.decideApproval(runRef, decision, challenge, ctx);
  }
  deletionChallenge(runRef: string, ctx: ExtensionContext) { this.assertPrimary(ctx); return this.controls.deletionChallenge(runRef, ctx); }
  deleteRun(runRef: string, challenge: string, ctx: ExtensionContext) { this.assertPrimary(ctx); return this.controls.deleteRun(runRef, challenge, ctx); }

  async restoreAsyncNotifications(ctx: ExtensionContext): Promise<void> {
    this.bindContext(ctx);
    const owner = sessionId(ctx);
    if (!owner) return;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== "workflow-completion") continue;
      const data = plainRecord(entry.data);
      if (typeof data?.runId === "string") this.notified.add(data.runId);
    }
    const currentProject = await fs.promises.realpath(projectRoot(ctx.cwd));
    for (const entry of (await this.catalog.list()).slice(0, 256)) {
      if (!entry.run || this.notified.has(entry.runId)) continue;
      let binding: WorkflowLaunchBinding | undefined;
      try { binding = readLaunchBinding(entry); } catch { continue; }
      const boundProject = binding
        ? await fs.promises.realpath(binding.projectRoot).catch(() => "")
        : "";
      if (!binding || binding.mode !== "async" || binding.sessionId !== owner
        || boundProject !== currentProject) continue;
      try { await assertReplayProject(entry.paths.projectManifest, ctx.cwd); } catch { continue; }
      const value = { entry, run: entry.run, binding };
      if (TERMINAL.has(entry.run.status)) this.notify(summary(entry.run, await this.shortId(entry.runId)));
      else this.watch(value, binding);
    }
  }

  private async launch(
    workflowId: string,
    args: JsonObject,
    authority: "model" | "user" | "rpc",
    mode: "await" | "async",
    ctx: ExtensionContext,
    replay?: { sourceRunId: string; sourceRunDir: string; fresh: boolean },
  ): Promise<{
    entry: WorkflowRunCatalogEntry;
    run: ReturnType<WorkflowRunDatabase["readRun"]>;
    binding: WorkflowLaunchBinding;
  }> {
    await this.catalog.ensureRoot();
    const ref = this.registry.resolve(workflowId);
    const availableModels = ctx.modelRegistry.getAvailable().map(model => `${model.provider}/${model.id}`);
    const defaultModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : availableModels[0];
    const prepared = await prepareWorkflowResources({
      workflow: ref.parsed,
      definitionHash: ref.definitionHash,
      cwd: ctx.cwd,
      includeProject: ctx.isProjectTrusted(),
      availableModels,
      ...(defaultModel ? { defaultModel } : {}),
      thinking: this.pi.getThinkingLevel(),
      agentExecutor: this.agentExecutorDescriptor,
      commandExecutor: this.commandExecutorDescriptor,
      measurementEnvironment: this.measurementEnvironmentDescriptor,
    });
    const snapshot = createWorkflowInvocationSnapshot(ref, args, {
      authority,
      projectTrusted: ctx.isProjectTrusted(),
      measurementProfiles: prepared.measurementProfiles,
    });
    const { runId, paths } = this.catalog.allocate();
    const temporary = path.join(this.catalog.root, `.launch-${runId}-${crypto.randomUUID()}`);
    let database: WorkflowRunDatabase | undefined;
    let published = false;
    let coordinatorStarted = false;
    try {
      await writeWorkflowInvocationSnapshot(temporary, snapshot);
      const temporaryPaths = { ...paths, root: temporary, database: path.join(temporary, "run.sqlite"),
        context: path.join(temporary, "context"), projectSnapshot: path.join(temporary, "context", "project"),
        projectManifest: path.join(temporary, "context", "project-manifest.json"),
        staticResources: path.join(temporary, "context", "static-resources.json") };
      for (const directory of ["sessions", "workspaces/candidates", "workspaces/checkpoints", "artifacts", "outputs"]) {
        await fs.promises.mkdir(path.join(temporary, directory), { recursive: true, mode: 0o700 });
      }
      const sourceRoot = await fs.promises.realpath(projectRoot(ctx.cwd));
      const sourceCwd = await fs.promises.realpath(ctx.cwd);
      const binding: WorkflowLaunchBinding = {
        mode,
        sessionId: sessionId(ctx)!,
        projectRoot: sourceRoot,
      };
      const project = await captureProjectSnapshot(sourceRoot, sourceCwd, temporaryPaths.projectSnapshot);
      await Promise.all([
        writeCanonical(temporaryPaths.projectManifest, project),
        writeCanonical(temporaryPaths.staticResources, prepared.static),
        ...(replay ? [writeCanonical(path.join(temporaryPaths.context, "replay.json"), { ...replay })] : []),
      ]);
      database = WorkflowRunDatabase.create(temporaryPaths.database, {
        runId,
        snapshot,
        projectSnapshotHash: project.treeHash,
        routeSnapshotHash: prepared.routeSnapshotHash,
        staticResourcesHash: prepared.static.hash,
        contextIdentityHash: stableHash({ prepared: prepared.contextIdentityHash, project: project.manifestHash }),
        launch: binding,
        safety: {
          concurrency: 4,
          maximumAgentLaunches: 1_000,
          memoryBytes: 2 * 1024 * 1024 * 1024,
          tasks: 256,
          cpuQuotaPercent: 400,
          cpuWeight: 100,
          outputBytes: 64 * 1024 * 1024,
          commandTimeoutMs: 10 * 60_000,
        },
        createdAt: new Date().toISOString(),
      });
      database.close(); database = undefined;
      await fs.promises.rename(temporary, paths.root);
      published = true;
      try { await this.coordinator.launch(paths.root); }
      catch (error) {
        if (!(error instanceof WorkflowCoordinatorAlreadyRunningError)) throw error;
      }
      coordinatorStarted = true;
      const reader = WorkflowRunDatabaseReader.open(paths.database);
      try {
        const run = reader.readRun();
        const entry = { runId, paths, run };
        await this.emit(entry);
        return { entry, run, binding };
      } finally { reader.close(); }
    } catch (error) {
      database?.close();
      await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      if (published && !coordinatorStarted) {
        await fs.promises.rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async awaitSettled(
    launched: { entry: WorkflowRunCatalogEntry; run: ReturnType<WorkflowRunDatabaseReader["readRun"]> },
    signal?: AbortSignal,
    onUpdate?: (summary: WorkflowRunSummary) => void | Promise<void>,
  ) {
    let revision = -1;
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("Workflow wait was cancelled");
      const reader = WorkflowRunDatabaseReader.open(launched.entry.paths.database);
      const run = (() => { try { return reader.readRun(); } finally { reader.close(); } })();
      if (run.revision !== revision) {
        revision = run.revision;
        await this.emit({ ...launched.entry, run });
        await onUpdate?.(summary(run, await this.shortId(run.runId)));
      }
      if (SETTLED.has(run.status)) return run;
      const unit = await this.coordinator.launcher.inspect(coordinatorUnitName(run.runId));
      if (!["active", "activating", "deactivating", "reloading"].includes(unit.activeState)) {
        try { await this.coordinator.launch(launched.entry.paths.root); }
        catch (error) { if (!(error instanceof WorkflowCoordinatorAlreadyRunningError)) throw error; }
      }
      await delay(200, signal);
    }
  }

  private async result(value: { entry: WorkflowRunCatalogEntry; run: ReturnType<WorkflowRunDatabaseReader["readRun"]> }): Promise<WorkflowNamedResult> {
    const runSummary = summary(value.run, await this.shortId(value.run.runId));
    return {
      runId: value.run.runId,
      status: value.run.status,
      summary: runSummary,
      ...(value.run.result !== undefined ? { result: structuredClone(value.run.result) } : {}),
      handoff: !TERMINAL.has(value.run.status),
    };
  }

  private watch(
    value: {
      entry: WorkflowRunCatalogEntry;
      run: ReturnType<WorkflowRunDatabaseReader["readRun"]>;
      binding?: WorkflowLaunchBinding;
    },
    binding: WorkflowLaunchBinding,
  ): void {
    if (!binding.sessionId || this.watchers.has(value.run.runId) || this.notified.has(value.run.runId)) return;
    let lastCoordinatorProbe = 0;
    const poll = async () => {
      this.watchers.delete(value.run.runId);
      if (!this.matchesBinding(binding)) return;
      try {
        const reader = WorkflowRunDatabaseReader.open(value.entry.paths.database);
        const run = (() => { try { return reader.readRun(); } finally { reader.close(); } })();
        await this.emit({ ...value.entry, run }, binding);
        if (TERMINAL.has(run.status)) {
          const terminal = summary(run, await this.shortId(run.runId));
          if (this.matchesBinding(binding)) this.notify(terminal);
          return;
        }
        if ((run.status === "queued" || run.status === "running")
          && Date.now() - lastCoordinatorProbe >= COORDINATOR_PROBE_MS) {
          lastCoordinatorProbe = Date.now();
          const state = await this.coordinator.launcher.inspect(coordinatorUnitName(run.runId));
          if (!["active", "activating", "deactivating", "reloading"].includes(state.activeState)) {
            try { await this.coordinator.launch(value.entry.paths.root); }
            catch (error) {
              if (!(error instanceof WorkflowCoordinatorAlreadyRunningError)) throw error;
            }
          }
        }
      } catch { /* retry presentation reads */ }
      if (!this.matchesBinding(binding)) return;
      const timer = setTimeout(() => void poll(), 250); timer.unref?.(); this.watchers.set(value.run.runId, timer);
    };
    const timer = setTimeout(() => void poll(), 250); timer.unref?.(); this.watchers.set(value.run.runId, timer);
  }

  private notify(run: WorkflowRunSummary): void {
    if (!this.context || this.notified.has(run.runId)) return;
    this.notified.add(run.runId);
    const content = `Workflow ${run.workflowId} (${run.shortRunId}) ended ${run.status}.`;
    const data = { runId: run.runId, shortRunId: run.shortRunId,
      workflowId: run.workflowId, status: run.status, revision: run.revision };
    this.pi.sendMessage({ customType: "workflow-completion", content, display: true, details: data }, { deliverAs: "nextTurn" });
    this.pi.appendEntry("workflow-completion", data);
    this.context.ui.notify(content, run.status === "failed" ? "error" : "info");
  }

  private async emit(
    entry: WorkflowRunCatalogEntry & { run: ReturnType<WorkflowRunDatabaseReader["readRun"]> },
    binding?: WorkflowLaunchBinding,
  ): Promise<void> {
    if (!this.listeners.size) return;
    try {
      const snapshot = await readWorkflowInvocationSnapshot(entry.paths.root);
      const reader = WorkflowRunDatabaseReader.open(entry.paths.database);
      const projection = (() => { try { return readWorkflowRunProjection(reader, snapshot, { shortRunId: entry.runId.slice(5, 13) }); }
        finally { reader.close(); } })();
      if (binding && !this.matchesBinding(binding)) return;
      for (const listener of this.listeners) listener(structuredClone(projection));
    } catch { /* projections never alter execution */ }
  }

  private assertPrimary(ctx: ExtensionContext): void {
    if (!sessionId(ctx)) throw new Error("Workflow launch requires an identified primary session");
    if (this.context && sessionId(this.context) !== sessionId(ctx)) throw new Error("Workflow launch is available only in the primary bound session");
    this.bindContext(ctx);
  }

  private async shortId(runId: string): Promise<string> {
    const ids = (await this.catalog.list()).map(entry => entry.runId);
    return workflowShortRunIds(ids).get(runId) ?? runId.slice(5, 13);
  }

  private matchesBinding(binding: WorkflowLaunchBinding): boolean {
    return Boolean(this.context)
      && sessionId(this.context!) === binding.sessionId
      && path.resolve(projectRoot(this.context!.cwd)) === path.resolve(binding.projectRoot);
  }

  private clearWatchers(): void {
    for (const timer of this.watchers.values()) clearTimeout(timer);
    this.watchers.clear();
  }
}

function summary(run: ReturnType<WorkflowRunDatabaseReader["readRun"]>, shortRunId = run.runId.slice(5, 13)): WorkflowRunSummary {
  return {
    runId: run.runId, shortRunId, workflowId: run.workflow.id, workflowName: run.workflow.name,
    status: run.status, revision: run.revision,
    ...(run.reason ? { reason: structuredClone(run.reason) } : {}),
    ...(run.currentOperationId ? { currentOperationId: run.currentOperationId } : {}),
    createdAt: run.createdAt, updatedAt: run.updatedAt, ...(run.endedAt ? { endedAt: run.endedAt } : {}),
  };
}

function corruptSummary(entry: WorkflowRunCatalogEntry, shortRunId = entry.runId.slice(5, 13)): WorkflowRunSummary {
  const at = new Date(0).toISOString();
  return {
    runId: entry.runId,
    shortRunId,
    workflowId: "unreadable",
    workflowName: "Unreadable workflow run",
    status: "corrupt",
    revision: 0,
    reason: { category: "system", code: "run-unreadable", summary: entry.error ?? "Unreadable workflow evidence", retryable: false },
    createdAt: at,
    updatedAt: at,
  };
}

async function writeCanonical(file: string, value: unknown): Promise<void> {
  const handle = await fs.promises.open(file, "wx", 0o600);
  try { await handle.writeFile(`${stableJson(value)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
}

function validateMode(mode: string, host: ExtensionContext["mode"]): void {
  if (mode !== "await" && mode !== "async") throw new Error("Workflow mode must be await or async");
  if (mode === "async" && host !== "tui" && host !== "rpc") throw new Error(`Async workflows are unavailable in ${host} mode`);
}
function sessionId(ctx: ExtensionContext): string | undefined { return ctx.sessionManager.getSessionId() ?? ctx.sessionManager.getHeader()?.id; }
function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readLaunchBinding(entry: WorkflowRunCatalogEntry): WorkflowLaunchBinding | undefined {
  if (!entry.run) return undefined;
  const reader = WorkflowRunDatabaseReader.open(entry.paths.database);
  try {
    const event = reader.listEvents({ limit: 1 })[0];
    const payload = plainRecord(event?.payload);
    const mode = payload?.mode;
    const owner = payload?.sessionId;
    const root = payload?.projectRoot;
    return event?.type === "run-created" && (mode === "await" || mode === "async")
      && typeof owner === "string" && typeof root === "string" && path.isAbsolute(root)
      ? { mode, sessionId: owner, projectRoot: root }
      : undefined;
  } finally { reader.close(); }
}

async function assertReplayProject(manifestPath: string, cwd: string): Promise<void> {
  const stat = await fs.promises.lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) {
    throw new Error("Replay source project manifest is unsafe");
  }
  const source = await fs.promises.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(source) as ProjectSnapshotManifest;
  if (source !== `${stableJson(manifest)}\n`) throw new Error("Replay source project manifest is noncanonical");
  assertProjectSnapshotManifest(manifest);
  const [sourceProject, currentProject] = await Promise.all([
    fs.promises.realpath(manifest.sourceRoot),
    fs.promises.realpath(projectRoot(cwd)),
  ]);
  if (sourceProject !== currentProject) throw new Error("Replay source belongs to another project");
}
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>(resolve => { const timer = setTimeout(done, ms); signal?.addEventListener("abort", done, { once: true });
    function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); } });
}
