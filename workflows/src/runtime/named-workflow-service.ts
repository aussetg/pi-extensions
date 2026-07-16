import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SdkAgentWorkerExecutor } from "../agents/sdk-executor.js";
import { AgentProfileRegistry } from "../agents/profiles.js";
import { prepareWorkflowExecutionResources } from "../agents/resources.js";
import type { WorkflowInvocationSnapshot } from "../definition/types.js";
import { RunCatalog, shortRunIds, type RunCatalogEntry } from "../persistence/run-catalog.js";
import { RunDatabase, RunDatabaseReader } from "../persistence/run-database.js";
import { readWorkflowInspectorPage } from "../projection/inspector-pages.js";
import type { WorkflowInspectorPageKind } from "../projection/types.js";
import type { WorkflowRunProjection } from "../projection/types.js";
import { projectRoot } from "../persistence/paths.js";
import { StructuredWorkflowRegistry } from "../registry/structured-workflows.js";
import type { JsonObject, JsonSchema, JsonValue } from "../types.js";
import { stableJson } from "../utils/stable-json.js";
import { buildRunContextIdentity } from "../workspaces/run-context.js";
import { captureProjectSnapshot } from "../workspaces/project-snapshot.js";
import { CoordinatorAlreadyRunningError, CoordinatorService } from "./coordinator-service.js";
import { coordinatorUnitName } from "./coordinator-identity.js";
import { zeroUsage, type RunRecord, type SafetyConfiguration } from "./durable-types.js";
import { semanticInvocationHash } from "./semantic-engine-helpers.js";
import type {
  NamedWorkflowClient,
  NamedWorkflowInvocation,
  NamedWorkflowResult,
  WorkflowInvocationAuthority,
  WorkflowReplayInvocation,
  WorkflowRunDetails,
  WorkflowRunSummary,
} from "./named-workflow-types.js";
import { WorkflowControlClient } from "./workflow-control-client.js";
import { readRunDetails, readWorkflowResult, summarizeRun } from "./workflow-run-values.js";

const SETTLED = new Set(["waiting", "paused", "completed", "failed", "stopped"]);
const TERMINAL = new Set(["completed", "failed", "stopped"]);
const POLL_MS = 250;
const COORDINATOR_PROBE_MS = 1_000;
const INVOCATION_BYTES = 512 * 1024;

export const DEFAULT_WORKFLOW_SAFETY: Readonly<SafetyConfiguration> = Object.freeze({
  concurrency: 4,
  maximumAgentLaunches: 1_000,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  tasks: 256,
  cpuQuotaPercent: 400,
  cpuWeight: 100,
  outputBytes: 64 * 1024 * 1024,
  commandTimeoutMs: 10 * 60_000,
});

export interface NamedWorkflowServiceOptions {
  registry?: StructuredWorkflowRegistry;
  catalog?: RunCatalog;
  coordinator?: CoordinatorService;
  safety?: SafetyConfiguration;
  pollIntervalMs?: number;
}

/**
 * Primary-session client for immutable launch preparation, SQLite controls,
 * and systemd coordinator wakeups. It never schedules workflow operations.
 */
export class NamedWorkflowService implements NamedWorkflowClient {
  readonly registry: StructuredWorkflowRegistry;
  readonly catalog: RunCatalog;
  readonly coordinator: CoordinatorService;
  readonly controls: WorkflowControlClient;
  readonly agentExecutorDescriptor = new SdkAgentWorkerExecutor().describe();
  private readonly safety: SafetyConfiguration;
  private readonly pollIntervalMs: number;
  private readonly watchers = new Map<string, NodeJS.Timeout>();
  private readonly notified = new Set<string>();
  private readonly projectionListeners = new Set<(projection: WorkflowRunProjection) => void>();
  private readonly projectedRevisions = new Map<string, number>();
  private context?: ExtensionContext;

  constructor(
    private readonly pi: ExtensionAPI,
    options: NamedWorkflowServiceOptions = {},
  ) {
    this.registry = options.registry ?? new StructuredWorkflowRegistry();
    this.catalog = options.catalog ?? new RunCatalog();
    this.coordinator = options.coordinator ?? new CoordinatorService();
    this.controls = new WorkflowControlClient(this.catalog, this.coordinator);
    this.safety = structuredClone(options.safety ?? DEFAULT_WORKFLOW_SAFETY);
    this.pollIntervalMs = boundedPoll(options.pollIntervalMs ?? POLL_MS);
  }

  bindContext(ctx: ExtensionContext): void {
    if (this.context && sessionId(this.context) !== sessionId(ctx)) this.clearWatchers();
    this.context = ctx;
  }

  detachContext(): void {
    this.clearWatchers();
    this.context = undefined;
  }

  subscribeProjection(listener: (projection: WorkflowRunProjection) => void): () => void {
    this.projectionListeners.add(listener);
    return () => this.projectionListeners.delete(listener);
  }

  async refreshDefinitions(ctx: ExtensionContext): Promise<void> {
    await this.registry.refresh(ctx.cwd, { includeProject: ctx.isProjectTrusted() });
  }

  async invoke(
    input: NamedWorkflowInvocation,
    authority: WorkflowInvocationAuthority,
    ctx: ExtensionContext,
    options: { onUpdate?: (summary: WorkflowRunSummary) => void | Promise<void> } = {},
  ): Promise<NamedWorkflowResult> {
    this.bindContext(ctx);
    validateMode(input.mode, ctx.mode);
    await this.refreshDefinitions(ctx);
    const ref = this.registry.resolve(input.name);
    if (authority === "model" && !ref.modelVisible) throw new Error(`Workflow ${ref.id} is not visible to the model`);
    const invocation = this.registry.snapshot(ref.id, input.args);
    const launched = await this.createAndLaunch(invocation, authority, input.mode, ctx);
    if (input.mode === "async") {
      this.watch(launched.entry, sessionId(ctx), projectRoot(ctx.cwd));
      return await this.result(launched.run, undefined);
    }
    const settled = await this.awaitSettled(launched.entry, ctx.signal, options.onUpdate);
    return await this.result(settled, settled.status === "completed"
      ? await readWorkflowResult(launched.entry, settled)
      : undefined);
  }

  async replay(
    input: WorkflowReplayInvocation,
    authority: WorkflowInvocationAuthority,
    ctx: ExtensionContext,
  ): Promise<NamedWorkflowResult> {
    this.bindContext(ctx);
    validateMode(input.mode, ctx.mode);
    const source = await this.catalog.resolve(input.sourceRunRef);
    if (!source.run) throw new Error(source.error ?? "Replay source run is unreadable");
    const sourceInvocation = await readInvocation(source.paths.invocation);
    if (sourceInvocation.workflowId !== source.run.workflow.id) throw new Error("Replay source invocation identity is corrupt");
    const binding = readLaunchBinding(source);
    const currentProject = await fs.promises.realpath(projectRoot(ctx.cwd));
    if (!binding || await fs.promises.realpath(binding.projectRoot).catch(() => "") !== currentProject) {
      throw new Error("Replay source belongs to another project");
    }
    await this.refreshDefinitions(ctx);
    const ref = this.registry.resolve(source.run.workflow.id);
    if (authority === "model" && !ref.modelVisible) throw new Error(`Workflow ${ref.id} is not visible to the model`);
    const args = input.args ?? sourceInvocation.input;
    const invocation = this.registry.snapshot(ref.id, args);
    const launched = await this.createAndLaunch(invocation, authority, input.mode, ctx, {
      sourceRunId: source.runId,
      sourceRunDir: source.paths.root,
      fresh: input.fresh,
    });
    if (input.mode === "async") {
      this.watch(launched.entry, sessionId(ctx), projectRoot(ctx.cwd));
      return await this.result(launched.run, undefined);
    }
    const settled = await this.awaitSettled(launched.entry, ctx.signal);
    return await this.result(settled, settled.status === "completed"
      ? await readWorkflowResult(launched.entry, settled)
      : undefined);
  }

  async list(_ctx: ExtensionContext): Promise<WorkflowRunSummary[]> {
    const entries = await this.catalog.list();
    const short = shortRunIds(entries.map((entry) => entry.runId));
    return entries.flatMap((entry) => entry.run
      ? [summarizeRun(entry.run, short.get(entry.runId))]
      : []);
  }

  async open(runRef: string, _ctx: ExtensionContext): Promise<WorkflowRunDetails> {
    const entry = await this.catalog.resolve(runRef);
    return readRunDetails(entry, await this.shortId(entry.runId));
  }

  async inspectPage(
    runRef: string,
    kind: WorkflowInspectorPageKind,
    options: { cursor?: string; limit?: number },
    _ctx: ExtensionContext,
  ) {
    const entry = await this.catalog.resolve(runRef);
    const reader = RunDatabaseReader.open(entry.paths.database);
    try { return readWorkflowInspectorPage(reader, kind, options); }
    finally { reader.close(); }
  }

  pause(runRef: string, ctx: ExtensionContext) { return this.controls.pause(runRef, ctx); }
  resume(runRef: string, ctx: ExtensionContext) { return this.controls.resume(runRef, ctx); }
  stop(runRef: string, ctx: ExtensionContext) { return this.controls.stop(runRef, ctx); }
  stopEffect(runRef: string, operationRef: string, ctx: ExtensionContext) {
    return this.controls.stopEffect(runRef, operationRef, ctx);
  }
  checkpointChallenge(runRef: string, checkpointId: string | undefined, ctx: ExtensionContext) {
    return this.controls.checkpointChallenge(runRef, checkpointId, ctx);
  }
  respond(runRef: string, checkpointId: string | undefined, challenge: string, value: JsonValue, ctx: ExtensionContext) {
    return this.controls.respond(runRef, checkpointId, challenge, value, ctx);
  }
  approvalChallenge(runRef: string, ctx: ExtensionContext) { return this.controls.approvalChallenge(runRef, ctx); }
  decideApproval(runRef: string, decision: "approve" | "reject", challenge: string, ctx: ExtensionContext) {
    return this.controls.decideApproval(runRef, decision, challenge, ctx);
  }
  deletionChallenge(runRef: string, ctx: ExtensionContext) { return this.controls.deletionChallenge(runRef, ctx); }
  deleteRun(runRef: string, challenge: string, ctx: ExtensionContext) { return this.controls.deleteRun(runRef, challenge, ctx); }

  async restoreAsyncNotifications(ctx: ExtensionContext): Promise<void> {
    this.bindContext(ctx);
    const owner = sessionId(ctx);
    if (!owner) return;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "workflow-completion") {
        const runId = plainRecord(entry.data) && typeof entry.data.runId === "string" ? entry.data.runId : undefined;
        if (runId) this.notified.add(runId);
      }
    }
    const currentProject = await fs.promises.realpath(projectRoot(ctx.cwd));
    for (const entry of (await this.catalog.list()).slice(0, 256)) {
      if (!entry.run || this.notified.has(entry.runId)) continue;
      let binding: ReturnType<typeof readLaunchBinding>;
      try { binding = readLaunchBinding(entry); } catch { continue; }
      const boundProject = binding ? await fs.promises.realpath(binding.projectRoot).catch(() => "") : "";
      if (!binding || binding.mode !== "async" || binding.sessionId !== owner || boundProject !== currentProject) continue;
      if (TERMINAL.has(entry.run.status)) this.notify(summarizeRun(entry.run, await this.shortId(entry.runId)));
      else this.watch(entry, owner, currentProject);
    }
  }

  private async createAndLaunch(
    invocation: WorkflowInvocationSnapshot,
    authority: WorkflowInvocationAuthority,
    mode: "await" | "async",
    ctx: ExtensionContext,
    replay?: { sourceRunId: string; sourceRunDir: string; fresh: boolean },
  ): Promise<{ entry: RunCatalogEntry; run: RunRecord }> {
    await this.catalog.ensureRoot();
    const staging = await fs.promises.mkdtemp(path.join(this.catalog.root, ".launch-"));
    let created: Awaited<ReturnType<RunCatalog["create"]>> | undefined;
    let preservePreparedRun = false;
    try {
      const availableModels = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);
      const selectedModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : availableModels[0];
      const profiles = new AgentProfileRegistry();
      await profiles.refresh(ctx.cwd, { includeProject: ctx.isProjectTrusted() });
      const routeDefaults = selectedModel
        ? Object.fromEntries(profiles.list().map((profile) => [profile.id, {
            model: selectedModel,
            thinking: this.pi.getThinkingLevel(),
          }]))
        : {};
      const ref = this.registry.resolve(invocation.workflowId);
      const resources = await prepareWorkflowExecutionResources(ref.parsed, {
        cwd: ctx.cwd,
        profileRegistry: profiles,
        routeDefaults,
        includeProjectProfiles: ctx.isProjectTrusted(),
        includeProjectCommands: ctx.isProjectTrusted(),
        includeProjectMeasurements: ctx.isProjectTrusted(),
        includeProjectVerifications: ctx.isProjectTrusted(),
        availableModels,
        policy: { allowedModels: availableModels },
        executorDescriptor: this.agentExecutorDescriptor,
      });
      const stagingProject = path.join(staging, "project");
      const project = await captureProjectSnapshot(resources.projectRoot, resources.projectCwd, stagingProject);
      const identity = buildRunContextIdentity({
        project,
        invocation,
        guidance: resources.contextBundle,
        profiles: resources.profiles,
        routes: resources.routes,
        tools: contextTools(resources.agentSelections.flatMap((selection) => selection.tools)),
      });
      const semanticInvocation = {
        workflowId: invocation.workflowId,
        definitionHash: invocation.definitionHash,
        input: invocation.input,
        inputHash: invocation.inputHash,
      };
      const at = new Date().toISOString();
      const run: Omit<RunRecord, "runId"> = {
        revision: 1,
        workflow: {
          id: invocation.workflowId,
          name: invocation.name,
          sourceHash: invocation.sourceHash,
          definitionHash: invocation.definitionHash,
          capabilities: [...invocation.capabilities],
        },
        invocationHash: semanticInvocationHash(semanticInvocation),
        projectSnapshotHash: project.treeHash,
        routeSnapshotHash: resources.routeSnapshotHash,
        contextIdentityHash: identity.hash,
        status: "queued",
        safety: structuredClone(this.safety),
        usage: zeroUsage(),
        ...(replay ? {
          replay: {
            mode: "cross-revision-prefix",
            sourceRunId: replay.sourceRunId,
            matchedCalls: 0,
            fresh: replay.fresh,
          },
        } : {}),
        createdAt: at,
        updatedAt: at,
      };
      created = await this.catalog.create({
        run,
        event: {
          type: "run-created",
          payload: {
            authority,
            mode,
            sessionId: sessionId(ctx) ?? "",
            projectRoot: resources.projectRoot,
          },
          at,
        },
      });
      created.database.close();
      await installContext(created.entry, stagingProject, invocation, project, identity, resources, replay);
      try {
        await this.coordinator.launch(created.entry.paths.root);
      } catch (error) {
        await pauseLaunchFailure(created.entry, error);
        preservePreparedRun = true;
        throw new Error(`Workflow ${created.entry.runId} was prepared but its coordinator could not start: ${errorMessage(error)}`);
      }
      const reader = RunDatabaseReader.open(created.entry.paths.database);
      try {
        const launchedRun = reader.readRun();
        this.emitProjection(created.entry, launchedRun, await this.shortId(launchedRun.runId));
        return { entry: { ...created.entry, run: launchedRun }, run: launchedRun };
      } finally {
        reader.close();
      }
    } catch (error) {
      if (created && !preservePreparedRun) {
        await fs.promises.rm(created.entry.paths.root, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      await makeTreeRemovable(staging).catch(() => undefined);
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async awaitSettled(
    entry: RunCatalogEntry,
    signal?: AbortSignal,
    onUpdate?: (summary: WorkflowRunSummary) => void | Promise<void>,
  ): Promise<RunRecord> {
    let revision = -1;
    let lastCoordinatorProbe = 0;
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("Workflow wait was cancelled");
      const reader = RunDatabaseReader.open(entry.paths.database);
      let run: RunRecord;
      try { run = reader.readRun(); } finally { reader.close(); }
      if (run.revision !== revision) {
        revision = run.revision;
        this.emitProjection(entry, run, await this.shortId(run.runId));
        await onUpdate?.(summarizeRun(run, await this.shortId(run.runId)));
      }
      if (SETTLED.has(run.status)) return run;
      if (Date.now() - lastCoordinatorProbe >= COORDINATOR_PROBE_MS) {
        lastCoordinatorProbe = Date.now();
        await this.reconcileInactiveCoordinator(entry, run);
      }
      await delay(this.pollIntervalMs, signal);
    }
  }

  private async result(run: RunRecord, result: JsonValue | undefined): Promise<NamedWorkflowResult> {
    const summary = summarizeRun(run, await this.shortId(run.runId));
    return {
      runId: run.runId,
      status: run.status,
      summary,
      ...(result !== undefined ? { result } : {}),
      ...(run.result ? { resultArtifact: run.result } : {}),
      handoff: !TERMINAL.has(run.status),
    };
  }

  private watch(entry: RunCatalogEntry, owner: string | undefined, expectedProject: string): void {
    if (!owner || this.watchers.has(entry.runId) || this.notified.has(entry.runId)) return;
    let lastCoordinatorProbe = 0;
    const poll = async () => {
      this.watchers.delete(entry.runId);
      if (!this.context || sessionId(this.context) !== owner || path.resolve(projectRoot(this.context.cwd)) !== path.resolve(expectedProject)) return;
      try {
        const reader = RunDatabaseReader.open(entry.paths.database);
        let run: RunRecord;
        try { run = reader.readRun(); } finally { reader.close(); }
        this.emitProjection(entry, run, await this.shortId(run.runId));
        if (TERMINAL.has(run.status)) {
          this.notify(summarizeRun(run, await this.shortId(run.runId)));
          return;
        }
        if (Date.now() - lastCoordinatorProbe >= COORDINATOR_PROBE_MS) {
          lastCoordinatorProbe = Date.now();
          await this.reconcileInactiveCoordinator(entry, run);
        }
      } catch { /* A transient read or systemd failure must not abandon the watcher. */ }
      if (!this.context || sessionId(this.context) !== owner || path.resolve(projectRoot(this.context.cwd)) !== path.resolve(expectedProject)) return;
      const timer = setTimeout(() => void poll(), this.pollIntervalMs);
      timer.unref?.();
      this.watchers.set(entry.runId, timer);
    };
    const timer = setTimeout(() => void poll(), this.pollIntervalMs);
    timer.unref?.();
    this.watchers.set(entry.runId, timer);
  }

  private notify(summary: WorkflowRunSummary): void {
    if (this.notified.has(summary.runId) || !this.context) return;
    this.notified.add(summary.runId);
    const content = boundedText(
      `Workflow ${summary.workflowId} (${summary.shortRunId}) completed with status ${summary.status}${summary.reason ? `: ${summary.reason.summary}` : "."}`,
      2_048,
    );
    const data = {
      formatVersion: 1,
      runId: summary.runId,
      shortRunId: summary.shortRunId,
      workflowId: summary.workflowId,
      status: summary.status,
      revision: summary.revision,
      endedAt: summary.endedAt ?? summary.updatedAt,
    };
    this.pi.sendMessage({ customType: "workflow-completion", content, display: true, details: data }, { deliverAs: "nextTurn" });
    this.pi.appendEntry("workflow-completion", data);
    this.context.ui.notify(content, summary.status === "failed" ? "error" : "info");
  }

  private emitProjection(entry: RunCatalogEntry, run: RunRecord, shortRunId: string): void {
    if (this.projectionListeners.size === 0 || this.projectedRevisions.get(run.runId) === run.revision) return;
    try {
      const projection = readRunDetails(entry, shortRunId);
      this.projectedRevisions.set(run.runId, run.revision);
      for (const listener of this.projectionListeners) listener(structuredClone(projection));
    } catch {
      // Projection is presentation only; a transient read must not affect the run.
    }
  }

  private async shortId(runId: string): Promise<string> {
    const entries = await this.catalog.list();
    return shortRunIds(entries.map((entry) => entry.runId)).get(runId) ?? runId.slice(5, 13);
  }

  private async reconcileInactiveCoordinator(entry: RunCatalogEntry, run: RunRecord): Promise<void> {
    if (SETTLED.has(run.status)) return;
    const state = await this.coordinator.launcher.inspect(coordinatorUnitName(run.runId));
    if (["active", "activating", "deactivating", "reloading"].includes(state.activeState)) return;
    try { await this.coordinator.launch(entry.paths.root); }
    catch (error) { if (!(error instanceof CoordinatorAlreadyRunningError)) throw error; }
  }

  private clearWatchers(): void {
    for (const timer of this.watchers.values()) clearTimeout(timer);
    this.watchers.clear();
  }
}

async function installContext(
  entry: RunCatalogEntry,
  stagingProject: string,
  invocation: WorkflowInvocationSnapshot,
  project: Awaited<ReturnType<typeof captureProjectSnapshot>>,
  identity: ReturnType<typeof buildRunContextIdentity>,
  resources: Awaited<ReturnType<typeof prepareWorkflowExecutionResources>>,
  replay?: { sourceRunId: string; sourceRunDir: string; fresh: boolean },
): Promise<void> {
  const targetProject = entry.paths.projectSnapshot;
  await fs.promises.rename(stagingProject, targetProject);
  const { source, installedPath: _installedPath, ...persistedInvocation } = invocation;
  await Promise.all([
    writeExclusive(entry.paths.source, source),
    writeExclusive(entry.paths.invocation, `${stableJson(persistedInvocation)}\n`),
    writeExclusive(entry.paths.projectManifest, `${stableJson(project)}\n`),
    writeExclusive(entry.paths.contextIdentity, `${stableJson(identity)}\n`),
    writeExclusive(path.join(entry.paths.context, "resources.json"), `${stableJson(resources)}\n`),
    ...(replay ? [writeExclusive(path.join(entry.paths.context, "replay.json"), `${stableJson({
      formatVersion: 1,
      sourceRunId: replay.sourceRunId,
      sourceRunDir: replay.sourceRunDir,
      fresh: replay.fresh,
    })}\n`)] : []),
  ]);
  await syncDirectory(entry.paths.context);
  await syncDirectory(entry.paths.root);
}

function contextTools(tools: Array<{ name: string; schemaHash: string; mutatesWorkspace: boolean; usesMediatedNetwork: boolean }>) {
  return [...new Map(tools.map((tool) => [tool.name, tool])).values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => ({
      name: tool.name,
      schema: { type: "object", "x-pinned-schema-hash": tool.schemaHash } as JsonSchema,
      mutatesWorkspace: tool.mutatesWorkspace,
      usesMediatedNetwork: tool.usesMediatedNetwork,
    }));
}

async function pauseLaunchFailure(entry: RunCatalogEntry, error: unknown): Promise<void> {
  const database = RunDatabase.open(entry.paths.database);
  try {
    const run = database.readRun();
    if (run.status !== "queued") return;
    const at = new Date().toISOString();
    database.transitionRun(run.revision, {
      status: "paused",
      reason: {
        category: "infrastructure",
        code: "coordinator-launch-failed",
        summary: boundedText(errorMessage(error), 2_048),
        retryable: true,
      },
      event: { type: "coordinator-launch-failed", payload: {}, at },
    });
  } finally {
    database.close();
  }
}

function readLaunchBinding(entry: RunCatalogEntry): { mode: string; sessionId: string; projectRoot: string } | undefined {
  const reader = RunDatabaseReader.open(entry.paths.database);
  try {
    const event = reader.listEvents({ limit: 1 })[0];
    if (event?.type !== "run-created") return undefined;
    const { mode, sessionId: owner, projectRoot: root } = event.payload;
    return typeof mode === "string" && typeof owner === "string" && typeof root === "string"
      ? { mode, sessionId: owner, projectRoot: root }
      : undefined;
  } finally {
    reader.close();
  }
}

async function readInvocation(filePath: string): Promise<Pick<WorkflowInvocationSnapshot, "workflowId" | "input">> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > INVOCATION_BYTES) throw new Error("Replay source invocation is unsafe");
  const value = JSON.parse(await fs.promises.readFile(filePath, "utf8")) as unknown;
  if (!plainRecord(value) || typeof value.workflowId !== "string" || !plainRecord(value.input)) {
    throw new Error("Replay source invocation is invalid");
  }
  return { workflowId: value.workflowId as WorkflowInvocationSnapshot["workflowId"], input: value.input as JsonObject };
}

function validateMode(mode: string, hostMode: ExtensionContext["mode"]): asserts mode is "await" | "async" {
  if (mode !== "await" && mode !== "async") throw new Error("Workflow mode must be await or async");
  if (mode === "async" && hostMode !== "tui" && hostMode !== "rpc") {
    throw new Error(`Async workflows are unavailable in ${hostMode} mode`);
  }
}

function boundedPoll(value: number): number {
  if (!Number.isSafeInteger(value) || value < 25 || value > 5_000) throw new Error("Workflow poll interval must be 25–5000ms");
  return value;
}

function boundedText(value: string, maximum: number): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, maximum).join("");
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function sessionId(ctx: ExtensionContext): string | undefined { return ctx.sessionManager.getSessionId() ?? ctx.sessionManager.getHeader()?.id; }
function plainRecord(value: unknown): value is Record<string, any> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
async function writeExclusive(filePath: string, text: string): Promise<void> {
  const handle = await fs.promises.open(filePath, "wx", 0o600);
  try { await handle.writeFile(text, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function makeTreeRemovable(root: string): Promise<void> {
  let stat: fs.Stats;
  try { stat = await fs.promises.lstat(root); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) { await fs.promises.chmod(root, 0o600).catch(() => undefined); return; }
  await fs.promises.chmod(root, 0o700).catch(() => undefined);
  for (const name of await fs.promises.readdir(root)) await makeTreeRemovable(path.join(root, name));
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", done, { once: true });
    function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
  });
}
