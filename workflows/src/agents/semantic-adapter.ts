import fs from "node:fs";
import path from "node:path";
import { ArtifactStore } from "../artifacts/store.js";
import { materializeAgentInputs } from "../artifacts/agent-inputs.js";
import { AgentEvidenceLog, type FinalizedAgentEvidenceLog } from "../artifacts/agent-attempt.js";
import {
  CandidateWorkspaceManager,
  type CandidateWorkspaceCapability,
  type CandidateWorkspaceHandle,
} from "../candidates/store.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import { RunDatabase, RunRevisionConflictError } from "../persistence/run-database.js";
import { WORKFLOW_JOURNAL_ROOT_KEY } from "../persistence/workflow-journal.js";
import {
  zeroUsage,
  type AgentSessionRecord,
  type ArtifactRef,
  type AttemptRecord,
  type WorkspaceRef,
} from "../runtime/durable-types.js";
import type {
  SemanticEffectAdapter,
  SemanticEffectAdmissionRequest,
  SemanticEffectJournalIdentity,
  SemanticEffectOutcome,
  SemanticEffectRequest,
  SemanticEffectRestoreRequest,
  SemanticReplayMaterialization,
  SemanticReplaySource,
} from "../runtime/semantic-engine-types.js";
import { validateJsonSchema } from "../runtime/semantic-engine-values.js";
import type { JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import {
  assertProjectSnapshotManifest,
  verifyProjectSnapshot,
  type ProjectSnapshotManifest,
} from "../workspaces/project-snapshot.js";
import { buildAgentCallKey, buildAgentSemanticKey, agentCallProvenance } from "./call-identity.js";
import type {
  AgentEvent,
  AgentEventSink,
  AgentExecutionHandle,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentExecutor,
  AgentInputBundleHandle,
  AgentProfileSnapshot,
  AgentRouteSnapshot,
  AgentWorkspaceHandle,
} from "./executor.js";
import { MISSING_RECEIPT_REMINDER } from "./executor.js";
import { agentWorkerUnitName } from "./sdk-executor.js";
import type { ResolvedAgentSelection } from "./resources.js";
import type { AgentMediatedToolExecutor } from "./mediation.js";
import { AgentLiveProgressProjector } from "./live-progress.js";
import { AgentProtocolServer } from "./sdk-protocol-server.js";
import { buildFinishWorkContract } from "./sdk-tools.js";
import {
  agentExecutionFailure,
  candidateAgentWorkspace,
  emptyAgentProgress,
  exactAgentSelection,
  logicalAgentIds,
  normalizeAgentOptions,
  resultFromFinish,
  workflowAgentValue,
  type NormalizedAgentOptions,
  type SemanticAgentExecutionResources,
} from "./semantic-adapter-values.js";

export { SemanticAgentExecutionError } from "./semantic-adapter-values.js";

const MAX_REVISION_RETRIES = 16;

export interface SemanticAgentAdapterOptions {
  runDir: string;
  database: RunDatabase;
  resources: SemanticAgentExecutionResources;
  executor: AgentExecutor;
  candidateManager?: CandidateWorkspaceManager;
  mediatedTools?: AgentMediatedToolExecutor;
  now?: () => Date;
}

interface ResolvedAgentAdmission {
  options: NormalizedAgentOptions;
  selection: ResolvedAgentSelection;
  profile: AgentProfileSnapshot;
  route: AgentRouteSnapshot;
  semanticWorkspace: WorkspaceRef;
  launchWorkspace: AgentWorkspaceHandle;
  candidate?: { manager: CandidateWorkspaceManager; capability: CandidateWorkspaceCapability; handle: CandidateWorkspaceHandle };
  finishSchemaHash: string;
  semanticInput: JsonValue;
  semanticKey: string;
}

/** The central flow.agent → persistent SDK session adapter. */
export class SemanticAgentAdapter implements SemanticEffectAdapter {
  readonly kind = "agent" as const;
  readonly runDir: string;
  private readonly store: ArtifactStore;
  private readonly projector: AgentLiveProgressProjector;
  private readonly evidence = new Map<string, AgentEvidenceLog>();
  private readonly admissions = new Map<string, Promise<ResolvedAgentAdmission>>();
  private readonly now: () => Date;
  private readonly protocol: AgentProtocolServer;
  private protocolStarted?: Promise<void>;
  private launchSnapshot?: Promise<{ manifest: ProjectSnapshotManifest; workspace: AgentWorkspaceHandle }>;

  constructor(private readonly options: SemanticAgentAdapterOptions) {
    this.runDir = path.resolve(options.runDir);
    if (path.resolve(options.database.databasePath) !== path.join(this.runDir, "run.sqlite")) {
      throw new Error("Semantic agent adapter and run database directories differ");
    }
    this.now = options.now ?? (() => new Date());
    this.store = new ArtifactStore(this.runDir, options.database, {
      maximumArtifactBytes: options.database.readRun().safety.outputBytes,
      now: this.now,
    });
    this.projector = new AgentLiveProgressProjector(options.database);
    this.protocol = new AgentProtocolServer(this.runDir, options.database, {
      now: this.now,
      ...(options.mediatedTools ? { mediatedTools: options.mediatedTools } : {}),
      eventSink: { emit: async (event) => await this.evidenceSink(event) },
    });
    this.assertPinnedResources();
  }

  async semanticInput(request: SemanticEffectAdmissionRequest): Promise<JsonValue> {
    return (await this.resolve(request)).semanticInput;
  }

  async journalIdentity(request: SemanticEffectAdmissionRequest): Promise<SemanticEffectJournalIdentity> {
    const resolved = await this.resolve(request);
    return {
      semanticKey: resolved.semanticKey,
      completionAuthority: "finish-work",
      replayPolicy: resolved.candidate ? "workspace" : "immutable",
    };
  }

  async execute(request: SemanticEffectRequest): Promise<SemanticEffectOutcome> {
    const resolved = await this.resolve(request);
    const ids = logicalAgentIds(request.run.runId, request.operation.operationId);
    const inputs = await materializeAgentInputs({
      store: this.store,
      root: path.join(this.runDir, "sessions", ids.executionId, "inputs"),
      inputs: resolved.options.inputs.map((entry) => ({ id: entry.id, artifact: entry.opaque })),
    });
    const admitted = await this.admit(request, resolved, ids, inputs);
    const evidence = new AgentEvidenceLog(this.runDir, {
      executionId: ids.executionId,
      operationId: request.operation.operationId,
      attemptId: ids.attemptId,
    });
    await evidence.initialize();
    this.evidence.set(ids.executionId, evidence);

    let execution: AgentExecutionResult;
    let evidenceFinalized = false;
    try {
      if (admitted.finish) {
        execution = {
          outcome: "finished",
          finish: admitted.finish,
          usage: { ...admitted.progress.usage, complete: false },
          transcriptComplete: false,
        };
      } else {
        await this.startProtocol();
        const controlGroup = this.agentControlGroup(request.run.runId, ids.executionId);
        const protocol = await this.protocol.authorize({
          executionId: ids.executionId,
          agentSessionId: ids.agentSessionId,
          operationId: request.operation.operationId,
          attemptId: ids.attemptId,
          ...(resolved.options.outputSchema ? { outputSchema: resolved.options.outputSchema } : {}),
          resultMode: resolved.options.resultMode,
          maximumArtifactBytes: Math.min(request.run.safety.outputBytes, DEFINITION_LIMITS.agentArtifactBytes),
          workspace: {
            mode: resolved.launchWorkspace.mode,
            root: resolved.launchWorkspace.root,
            cwd: resolved.launchWorkspace.cwd,
          },
          network: resolved.options.network,
          signal: request.signal,
          ...(controlGroup ? { controlGroup } : {}),
        });
        const actualWorkspace = await this.currentLaunchWorkspace(resolved);
        const executionRequest = this.executionRequest(
          request,
          resolved,
          ids,
          inputs,
          protocol,
          actualWorkspace,
          admitted.created,
          admitted.receiptlessStrikes > 0,
        );
        const directSink: AgentEventSink = {
          emit: async (event) => {
            await this.projector.emit(event);
            await evidence.emit(event);
          },
        };
        const handle = await this.options.executor.start(executionRequest, directSink);
        execution = await waitWithCancellation(handle, request.signal);
      }

      if (execution.outcome !== "finished") throw agentExecutionFailure(execution, request.operation.operationId);
      const session = this.options.database.readAgentSession(ids.agentSessionId);
      if (!session?.finish) throw new Error("Agent claimed completion without a durable finish_work receipt");
      if (stableHash(session.finish) !== stableHash(execution.finish)) {
        throw new Error("Agent result differs from its durable finish_work receipt");
      }
      if (session.finish.schemaHash !== resolved.finishSchemaHash) {
        throw new Error("Agent finish_work receipt used a different output schema");
      }
      await this.validateFinish(resolved, session.finish.value, session.finish.artifacts);
      const finalized = await evidence.finalize();
      evidenceFinalized = true;
      const transcript = await this.storeTranscript(finalized, execution.transcriptComplete, ids.agentSessionId);
      const result = resultFromFinish(resolved.options.resultMode, session.finish.value, session.finish.artifacts);
      const current = this.options.database.readAgentSession(ids.agentSessionId)!;
      const checkpoint = resolved.candidate
        ? await resolved.candidate.manager.prepareCheckpoint({
            operationId: request.operation.operationId,
            workspace: resolved.candidate.capability,
            createdAt: this.timestamp(),
          })
        : undefined;
      if (checkpoint) {
        const descriptor = await this.store.putJson({
          expectedRevision: this.options.database.readRun().revision,
          kind: "workspace-checkpoint",
          value: {
            formatVersion: 1,
            operationPath: request.path,
            treeHash: checkpoint.record.workspace.treeHash,
            lineageHash: checkpoint.record.workspace.lineageHash!,
            writeScopeHash: checkpoint.record.workspace.writeScopeHash!,
          },
          metadata: {
            checkpointId: checkpoint.record.checkpointId,
            operationId: checkpoint.record.operationId,
          },
          // Operation creation is stable across crash recovery; a fresh wall
          // clock here would make an already-registered descriptor collide.
          createdAt: request.operation.createdAt,
        });
        result.workspace = checkpoint.record.workspace;
        result.artifacts.push(descriptor.artifact);
      }
      return {
        result,
        attemptId: ids.attemptId,
        usage: current.progress.usage,
        ...(current.progress.resources ? { resources: current.progress.resources } : {}),
        evidenceArtifacts: [transcript.digest],
        ...(checkpoint ? { workspaceCheckpoint: checkpoint.record } : {}),
        completionAuthority: "finish-work",
      };
    } finally {
      this.protocol.revoke(ids.executionId);
      this.evidence.delete(ids.executionId);
      if (!evidenceFinalized) await evidence.finalize().catch(() => undefined);
    }
  }

  async materializeReplay(
    request: SemanticEffectRequest,
    source: SemanticReplaySource,
  ): Promise<SemanticReplayMaterialization> {
    const resolved = await this.resolve(request);
    if (!resolved.candidate || !source.workspaceCheckpoint) {
      throw new Error("Agent replay has no candidate checkpoint authority");
    }
    const current = await resolved.candidate.manager.describe(resolved.candidate.capability);
    const imported = await resolved.candidate.manager.importCheckpointForReplay({
      sourceRunDir: source.runDir,
      source: source.workspaceCheckpoint,
      operationId: request.operation.operationId,
      workspace: resolved.candidate.capability,
      expectedPreTreeHash: current.ref.treeHash,
      createdAt: this.timestamp(),
    });
    return {
      result: { ...source.call.result, workspace: imported.record.workspace },
      workspaceCheckpoint: imported.record,
    };
  }

  async restore(request: SemanticEffectRestoreRequest): Promise<unknown> {
    const resolved = await this.resolve(request);
    if (resolved.candidate) {
      await resolved.candidate.manager.restoreForReplay(
        request.operation.operationId,
        resolved.candidate.capability,
      );
    }
    for (const artifact of request.operation.result.artifacts) await this.store.read(artifact.digest);
    return workflowAgentValue(resolved.options.resultMode, request.operation.result);
  }

  async dispose(): Promise<void> {
    await this.protocol.close();
    this.protocolStarted = undefined;
  }

  private agentControlGroup(runId: string, executionId: string): string | undefined {
    if (this.options.executor.describe().id !== "pi-sdk-worker") return undefined;
    try {
      const unified = fs.readFileSync("/proc/self/cgroup", "utf8")
        .split("\n")
        .find((line) => line.startsWith("0::/"))
        ?.slice(3);
      if (!unified) return undefined;
      return path.posix.join(path.posix.dirname(unified), agentWorkerUnitName(runId, executionId));
    } catch {
      return undefined;
    }
  }

  private resolve(request: SemanticEffectAdmissionRequest): Promise<ResolvedAgentAdmission> {
    const existing = this.admissions.get(request.path);
    if (existing) return existing;
    const pending = this.resolveUncached(request);
    this.admissions.set(request.path, pending);
    return pending;
  }

  private async resolveUncached(request: SemanticEffectAdmissionRequest): Promise<ResolvedAgentAdmission> {
    const options = normalizeAgentOptions(request.input);
    const selection = exactAgentSelection(this.options.resources, request.sourceId);
    const profileId = this.options.resources.profileSelectors[options.profile]
      ?? (this.options.resources.profiles.some((profile) => profile.id === options.profile) ? options.profile : undefined);
    if (profileId !== selection.profileId) throw new Error(`Agent ${request.path} changed its reviewed profile authority`);
    if (options.network !== selection.network || options.resultMode !== selection.resultMode) {
      throw new Error(`Agent ${request.path} changed its reviewed network or result authority`);
    }
    const expectsCandidate = selection.workspace === "candidate";
    if (expectsCandidate !== (options.workspace !== undefined)) {
      throw new Error(`Agent ${request.path} changed its reviewed workspace authority`);
    }
    const profile = this.options.resources.profiles.find((entry) => entry.id === selection.profileId);
    const route = this.options.resources.routes.find((entry) => entry.id === selection.routeId);
    if (!profile || !route || profile.hash !== selection.profileHash || route.hash !== selection.routeHash) {
      throw new Error(`Agent ${request.path} has corrupt pinned profile or route authority`);
    }
    const authorityHash = stableHash({
      ...agentCallProvenance(profile, route, selection.tools),
      workspace: selection.workspace,
      network: selection.network,
      resultMode: selection.resultMode,
    });
    if (authorityHash !== selection.authorityHash) throw new Error(`Agent ${request.path} authority hash is corrupt`);

    let candidate: ResolvedAgentAdmission["candidate"];
    let launchWorkspace: AgentWorkspaceHandle;
    let currentSemanticWorkspace: WorkspaceRef;
    if (options.workspace) {
      const manager = this.options.candidateManager;
      if (!manager) throw new Error(`Agent ${request.path} requires a candidate manager`);
      const handle = await manager.describe(options.workspace);
      candidate = { manager, capability: options.workspace, handle };
      launchWorkspace = candidateAgentWorkspace(handle);
      currentSemanticWorkspace = handle.ref;
    } else {
      const snapshot = await this.readLaunchSnapshot();
      launchWorkspace = snapshot.workspace;
      currentSemanticWorkspace = snapshot.workspace.workspace;
    }
    const existingOperation = this.options.database.readOperationByPath(request.path);
    const existingSession = existingOperation
      ? this.options.database.readAgentSessionByOperation(existingOperation.operationId)
      : undefined;
    const semanticWorkspace = existingSession?.workspace ?? currentSemanticWorkspace;
    if (
      semanticWorkspace.workspaceId !== currentSemanticWorkspace.workspaceId
      || semanticWorkspace.lineageHash !== currentSemanticWorkspace.lineageHash
      || semanticWorkspace.writeScopeHash !== currentSemanticWorkspace.writeScopeHash
    ) throw new Error(`Agent ${request.path} workspace authority changed across recovery`);

    const finish = buildFinishWorkContract(options.outputSchema);
    const semanticInput: JsonValue = {
      formatVersion: 1,
      prompt: options.prompt,
      inputs: options.inputs.map((entry) => ({ id: entry.id, artifact: entry.artifact })),
      finishSchemaHash: finish.schemaHash,
      workspace: semanticWorkspace.kind === "snapshot"
        ? { kind: "snapshot", treeHash: semanticWorkspace.treeHash }
        : {
            kind: "candidate",
            treeHash: semanticWorkspace.treeHash,
            writeScopeHash: semanticWorkspace.writeScopeHash,
          },
      contextIdentityHash: request.run.contextIdentityHash,
      network: options.network,
      resultMode: options.resultMode,
    } as unknown as JsonValue;
    const semanticKey = buildAgentSemanticKey({
      semanticInputHash: stableHash(semanticInput),
      finishSchemaHash: finish.schemaHash,
      inputArtifactDigests: options.inputs.map((entry) => entry.artifact.digest),
      network: options.network,
      preWorkspaceHash: semanticWorkspace.treeHash,
      profile,
      route,
      tools: selection.tools,
    });
    return {
      options,
      selection,
      profile,
      route,
      semanticWorkspace,
      launchWorkspace,
      ...(candidate ? { candidate } : {}),
      finishSchemaHash: finish.schemaHash,
      semanticInput,
      semanticKey,
    };
  }

  private async admit(
    request: SemanticEffectRequest,
    resolved: ResolvedAgentAdmission,
    ids: ReturnType<typeof logicalAgentIds>,
    inputs: AgentInputBundleHandle,
  ): Promise<AgentSessionRecord & { created: boolean }> {
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      const at = this.timestamp();
      const attempt: AttemptRecord = {
        attemptId: ids.attemptId,
        runId: request.run.runId,
        operationId: request.operation.operationId,
        number: 1,
        effect: "agent",
        executionId: ids.executionId,
        status: "running",
        preWorkspace: resolved.semanticWorkspace,
        usage: zeroUsage(),
        outputArtifacts: [],
        startedAt: at,
        updatedAt: at,
      };
      const session: AgentSessionRecord = {
        agentSessionId: ids.agentSessionId,
        runId: request.run.runId,
        operationId: request.operation.operationId,
        profileId: resolved.profile.id,
        routeId: resolved.route.id,
        piSessionPath: `sessions/${ids.executionId}/session.jsonl`,
        workspace: resolved.semanticWorkspace,
        network: resolved.options.network,
        status: "running",
        receiptlessStrikes: 0,
        currentExecutionId: ids.executionId,
        progress: emptyAgentProgress(at),
        createdAt: at,
        updatedAt: at,
      };
      try {
        const admitted = this.options.database.admitAgentExecution({
          expectedRevision: this.options.database.readRun().revision,
          attempt,
          session,
          inputArtifacts: inputs.entries.map((entry) => ({ id: entry.id, artifact: entry.artifact })),
          event: { type: "agent-execution-admitted", operationId: request.operation.operationId, attemptId: ids.attemptId, payload: {
            agentSessionId: ids.agentSessionId,
            executionId: ids.executionId,
            profileId: resolved.profile.id,
            routeId: resolved.route.id,
          }, at },
        });
        return Object.assign(admitted.session, { created: admitted.created });
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Could not admit agent execution after repeated revision races");
  }

  private executionRequest(
    request: SemanticEffectRequest,
    resolved: ResolvedAgentAdmission,
    ids: ReturnType<typeof logicalAgentIds>,
    inputs: AgentInputBundleHandle,
    protocol: AgentExecutionRequest["protocol"],
    workspace: AgentWorkspaceHandle,
    initial: boolean,
    resumeWithReminder: boolean,
  ): AgentExecutionRequest {
    const previousJournalKey = this.options.database.readLastWorkflowCall()?.callKey ?? WORKFLOW_JOURNAL_ROOT_KEY;
    const semanticCallKey = buildAgentCallKey({
      previousJournalKey,
      operationIdentity: request.operation.path,
      semanticInputHash: request.operation.semanticInputHash,
      finishSchemaHash: resolved.finishSchemaHash,
      inputArtifactDigests: resolved.options.inputs.map((entry) => entry.artifact.digest),
      network: resolved.options.network,
      preWorkspaceHash: resolved.semanticWorkspace.treeHash,
      profile: resolved.profile,
      route: resolved.route,
      tools: resolved.selection.tools,
    });
    const base = {
      runId: request.run.runId,
      operationId: request.operation.operationId,
      operationPath: request.operation.path,
      attemptId: ids.attemptId,
      executionId: ids.executionId,
      profile: resolved.profile,
      route: resolved.route,
      tools: resolved.selection.tools,
      network: resolved.options.network,
      ...(resolved.options.outputSchema ? { outputSchema: resolved.options.outputSchema } : {}),
      resultMode: resolved.options.resultMode,
      workspace,
      inputs,
      context: this.options.resources.contextBundle,
      protocol,
      semanticCallKey,
      safety: request.run.safety,
    };
    return initial ? {
      ...base,
      instruction: { kind: "initial-task", task: resolved.options.prompt },
      session: { agentSessionId: ids.agentSessionId, piSessionPath: `sessions/${ids.executionId}/session.jsonl`, resume: false },
    } : resumeWithReminder ? {
      ...base,
      instruction: { kind: "missing-receipt-reminder", text: MISSING_RECEIPT_REMINDER },
      session: { agentSessionId: ids.agentSessionId, piSessionPath: `sessions/${ids.executionId}/session.jsonl`, resume: true },
    } : {
      ...base,
      instruction: { kind: "resume" },
      session: { agentSessionId: ids.agentSessionId, piSessionPath: `sessions/${ids.executionId}/session.jsonl`, resume: true },
    };
  }

  private async currentLaunchWorkspace(resolved: ResolvedAgentAdmission): Promise<AgentWorkspaceHandle> {
    if (!resolved.candidate) return resolved.launchWorkspace;
    return candidateAgentWorkspace(await resolved.candidate.manager.describe(resolved.candidate.capability));
  }

  private async validateFinish(
    resolved: ResolvedAgentAdmission,
    value: JsonValue | undefined,
    artifacts: ArtifactRef[],
  ): Promise<void> {
    if (resolved.options.resultMode === "artifact") {
      if (value !== undefined) throw new Error("Artifact-only finish_work unexpectedly returned a value");
    } else {
      if (value === undefined) throw new Error("Agent finish_work receipt has no value");
      if (resolved.options.outputSchema) validateJsonSchema(resolved.options.outputSchema, value, "agent finish_work outputSchema");
      else if (typeof value !== "string") throw new Error("Schema-less finish_work value is not text");
    }
    if ((resolved.options.resultMode === "artifact" || resolved.options.resultMode === "value-and-artifact") && artifacts.length === 0) {
      throw new Error(`${resolved.options.resultMode} finish_work requires a published artifact`);
    }
    for (const artifact of artifacts) await this.store.read(artifact.digest);
  }

  private async storeTranscript(
    evidence: FinalizedAgentEvidenceLog,
    transcriptComplete: boolean,
    agentSessionId: string,
  ): Promise<ArtifactRef> {
    const existing = this.options.database.readArtifact(evidence.digest);
    if (existing) {
      if (existing.kind !== "agent-transcript" || existing.metadata.agentSessionId !== agentSessionId) {
        throw new Error(`Transcript artifact ${evidence.digest} has conflicting provenance`);
      }
      await this.store.read(existing.digest);
      return { digest: existing.digest, kind: existing.kind, mediaType: existing.mediaType, bytes: existing.bytes };
    }
    const createdAt = this.timestamp();
    for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
      try {
        const stored = await this.store.putFile({
          expectedRevision: this.options.database.readRun().revision,
          kind: "agent-transcript",
          filePath: path.join(this.runDir, evidence.path),
          metadata: {
            agentSessionId,
            executionId: path.basename(path.dirname(evidence.path)),
            events: evidence.events,
            transcriptComplete,
            evidenceDigest: evidence.digest,
          },
          maximumBytes: Math.min(this.options.database.readRun().safety.outputBytes, DEFINITION_LIMITS.agentTranscriptBytes),
          createdAt,
        });
        return stored.artifact;
      } catch (error) {
        if (error instanceof RunRevisionConflictError) continue;
        throw error;
      }
    }
    throw new Error("Could not register agent transcript after repeated revision races");
  }

  private async evidenceSink(event: AgentEvent): Promise<void> {
    const log = this.evidence.get(event.executionId);
    if (!log) throw new Error(`No evidence log is bound to agent execution ${event.executionId}`);
    await log.emit(event);
  }

  private async startProtocol(): Promise<void> {
    this.protocolStarted ??= this.protocol.start();
    await this.protocolStarted;
  }

  private readLaunchSnapshot(): Promise<{ manifest: ProjectSnapshotManifest; workspace: AgentWorkspaceHandle }> {
    this.launchSnapshot ??= (async () => {
      const manifestPath = path.join(this.runDir, "context", "project-manifest.json");
      const source = await fs.promises.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(source) as ProjectSnapshotManifest;
      if (source !== `${stableJson(manifest)}\n`) throw new Error("Project snapshot manifest is not canonical");
      assertProjectSnapshotManifest(manifest);
      const root = path.join(this.runDir, "context", "project");
      await verifyProjectSnapshot(root, manifest);
      const run = this.options.database.readRun();
      if (manifest.treeHash !== run.projectSnapshotHash) throw new Error("Agent launch snapshot differs from its run identity");
      const cwd = path.resolve(root, manifest.cwd === "." ? "" : manifest.cwd);
      const workspaceRef: WorkspaceRef & { kind: "snapshot" } = {
        kind: "snapshot",
        workspaceId: `snapshot_${stableHash({ runId: run.runId, treeHash: manifest.treeHash }).slice(7, 39)}`,
        treeHash: manifest.treeHash,
      };
      return {
        manifest,
        workspace: { mode: "read-only", root, cwd, preTreeHash: manifest.treeHash, workspace: workspaceRef },
      };
    })();
    return this.launchSnapshot;
  }

  private assertPinnedResources(): void {
    const run = this.options.database.readRun();
    const resources = this.options.resources;
    const { hash, ...body } = resources;
    if (stableHash(body) !== hash) throw new Error("Pinned agent resource manifest is corrupt");
    if (resources.formatVersion !== 1 || resources.definitionSourceHash !== run.workflow.sourceHash) {
      throw new Error("Pinned agent resources belong to another workflow source");
    }
    if (resources.routeSnapshotHash !== run.routeSnapshotHash) throw new Error("Pinned agent routes differ from the run identity");
    if (!resources.executor || stableHash(resources.executor) !== stableHash(this.options.executor.describe())) {
      throw new Error("Agent executor differs from its pinned semantic tool authority");
    }
    if (resources.agentSelections.some((selection) => selection.tools.some((tool) => tool.name === "workflow"))) {
      throw new Error("Pinned agent authority contains the workflow tool");
    }
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Semantic agent clock is invalid");
    return value.toISOString();
  }
}

async function waitWithCancellation(handle: AgentExecutionHandle, signal: AbortSignal): Promise<AgentExecutionResult> {
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void handle.cancel("scope-failure");
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try { return await handle.wait(); }
  finally {
    signal.removeEventListener("abort", cancel);
    await handle.dispose?.();
  }
}
