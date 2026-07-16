import path from "node:path";
import { ArtifactStore, createOpaqueArtifactRef } from "../artifacts/store.js";
import {
  CandidateWorkspaceManager,
  type CandidateWorkspaceCapability,
  type CandidateWorkspaceHandle,
} from "../candidates/store.js";
import { describeOpaqueCandidateWorkspace } from "../candidates/refs.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import { zeroUsage, type AttemptRecord, type OperationResult, type WorkspaceRef } from "../runtime/durable-types.js";
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
import { toResourceMeasurement } from "../systemd/cgroup-metrics.js";
import type { JsonValue } from "../types.js";
import { sha256, stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import {
  type HostCommandExecutor,
  type HostCommandResult,
  sameCommandExecutorProtocol,
} from "./executor.js";
import {
  resolveCommandInvocation,
  resolveCommandProfile,
  type CommandArgumentValues,
  type CommandEffect,
  type CommandProfileSnapshot,
  type ResolvedCommandInvocation,
} from "./profiles.js";

interface CommandOptions {
  profile: string;
  args: CommandArgumentValues;
  effect: CommandEffect;
  output: "summary" | "stdout" | "json";
  allowFailure: boolean;
  workspace?: CandidateWorkspaceCapability;
}

interface ResolvedCommand {
  options: CommandOptions;
  profile: CommandProfileSnapshot;
  invocation: ResolvedCommandInvocation;
  workspace: WorkspaceRef;
  workspaceRoot: string;
  cwd: string;
  candidate?: {
    capability: CandidateWorkspaceCapability;
    handle: CandidateWorkspaceHandle;
  };
  semanticInput: JsonValue;
}

interface StoredCommandValue {
  ok: boolean;
  exitCode: number;
  durationMs: number;
  output: "summary" | "stdout" | "json";
  stdout?: string;
  json?: JsonValue;
  stderrPreview?: string;
  outputDigest: string;
}

export interface SemanticCommandAdapterOptions {
  runDir: string;
  database: import("../persistence/run-database.js").RunDatabase;
  profiles: readonly CommandProfileSnapshot[];
  executor: HostCommandExecutor;
  pinnedExecutor?: ReturnType<HostCommandExecutor["describe"]>;
  launchWorkspace: {
    root: string;
    cwd: string;
    workspace: WorkspaceRef & { kind: "snapshot" };
  };
  candidateManager: CandidateWorkspaceManager;
  now?: () => Date;
}

/** Reviewed named commands executed only through the pinned Bubblewrap/systemd protocol. */
export class SemanticCommandAdapter implements SemanticEffectAdapter {
  readonly kind = "command" as const;
  private readonly runDir: string;
  private readonly store: ArtifactStore;
  private readonly now: () => Date;
  private readonly admissions = new Map<string, Promise<ResolvedCommand>>();

  constructor(private readonly options: SemanticCommandAdapterOptions) {
    this.runDir = path.resolve(options.runDir);
    if (path.resolve(options.database.databasePath) !== path.join(this.runDir, "run.sqlite")) {
      throw new Error("Command adapter and run database directories differ");
    }
    const pinned = options.database.readRun();
    const descriptor = options.pinnedExecutor;
    if (descriptor && !sameCommandExecutorProtocol(descriptor, options.executor.describe())) {
      throw new Error("Command executor differs from its pinned protocol");
    }
    this.store = new ArtifactStore(this.runDir, options.database, {
      maximumArtifactBytes: pinned.safety.outputBytes,
      now: options.now,
    });
    this.now = options.now ?? (() => new Date());
    assertContained(this.runDir, path.resolve(options.launchWorkspace.root));
    assertContained(path.resolve(options.launchWorkspace.root), path.resolve(options.launchWorkspace.cwd), true);
  }

  async semanticInput(request: SemanticEffectAdmissionRequest): Promise<JsonValue> {
    return (await this.resolve(request)).semanticInput;
  }

  async journalIdentity(request: SemanticEffectAdmissionRequest): Promise<SemanticEffectJournalIdentity> {
    const resolved = await this.resolve(request);
    return {
      semanticKey: stableHash({
        formatVersion: 1,
        kind: "named-command",
        semanticInput: resolved.semanticInput,
        contextIdentityHash: request.run.contextIdentityHash,
      }),
      completionAuthority: "host-effect",
      replayPolicy: resolved.candidate ? "workspace" : "immutable",
    };
  }

  async execute(request: SemanticEffectRequest): Promise<SemanticEffectOutcome> {
    const resolved = await this.resolve(request);
    const attempt = this.admitAttempt(request, resolved);
    const executionId = attempt.executionId!;
    const maximumOutputBytes = Math.min(
      request.run.safety.outputBytes,
      resolved.profile.outputLimitBytes,
      DEFINITION_LIMITS.commandStreamBytes,
    );
    const result = await this.options.executor.execute({
      runId: request.run.runId,
      operationPath: request.path,
      attempt: attempt.number,
      executionId,
      runDir: this.runDir,
      workspaceRoot: resolved.workspaceRoot,
      cwd: resolved.cwd,
      profile: resolved.profile,
      arguments: resolved.options.args,
      effect: resolved.options.effect,
      maximumOutputBytes,
      inlineLimitBytes: maximumOutputBytes,
    }, request.signal);
    this.assertResult(resolved, result);

    if (result.status !== "completed") {
      throw new Error(result.message ?? `Command ${resolved.profile.id} ended ${result.status}`);
    }
    if (result.exitCode !== 0 && !resolved.options.allowFailure) {
      throw new Error(`Command ${resolved.profile.id} exited ${result.exitCode ?? "without an exit code"}`);
    }

    const stdout = await this.store.putBytes({
      expectedRevision: request.database.readRun().revision,
      kind: "command-output",
      bytes: result.stdout,
      metadata: {},
      maximumBytes: maximumOutputBytes,
      createdAt: result.startedAt,
    });
    const artifacts = [stdout.artifact];

    const value = commandValue(resolved.options, result, stdout.artifact.digest);
    const operationResult: OperationResult = { value: value as unknown as JsonValue, artifacts };
    let checkpoint: Awaited<ReturnType<CandidateWorkspaceManager["prepareCheckpoint"]>> | undefined;
    if (resolved.candidate) {
      checkpoint = await this.options.candidateManager.prepareCheckpoint({
        operationId: request.operation.operationId,
        workspace: resolved.candidate.capability,
        createdAt: this.timestamp(),
      });
      operationResult.workspace = checkpoint.record.workspace;
    }
    return {
      result: operationResult,
      attemptId: attempt.attemptId,
      usage: { ...zeroUsage(), elapsedMs: duration(result) },
      ...(result.resources ? { resources: toResourceMeasurement(result.resources) } : {}),
      ...(checkpoint ? { workspaceCheckpoint: checkpoint.record } : {}),
      completionAuthority: "host-effect",
    };
  }

  async materializeReplay(
    request: SemanticEffectRequest,
    source: SemanticReplaySource,
  ): Promise<SemanticReplayMaterialization> {
    const resolved = await this.resolve(request);
    if (!resolved.candidate || !source.workspaceCheckpoint) {
      throw new Error("Command replay has no candidate checkpoint authority");
    }
    const current = await this.options.candidateManager.describe(resolved.candidate.capability);
    const imported = await this.options.candidateManager.importCheckpointForReplay({
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

  async restore(request: SemanticEffectRestoreRequest): Promise<object> {
    const resolved = await this.resolve(request);
    if (resolved.candidate) {
      await this.options.candidateManager.restoreForReplay(
        request.operation.operationId,
        resolved.candidate.capability,
      );
    }
    const value = parseStoredValue(request.operation.result.value);
    const output = request.database.readArtifact(value.outputDigest);
    if (!output || output.kind !== "command-output") throw new Error(`Command ${request.path} has no exact output artifact`);
    if (!request.operation.result.artifacts.some((artifact) => artifact.digest === output.digest)) {
      throw new Error(`Command ${request.path} output artifact is not bound to its result`);
    }
    const { outputDigest: _outputDigest, output: _output, ...publicValue } = value;
    return Object.freeze({
      ...structuredClone(publicValue),
      outputArtifact: createOpaqueArtifactRef({
        digest: output.digest,
        kind: output.kind,
        mediaType: output.mediaType,
        bytes: output.bytes,
      }),
    });
  }

  private resolve(request: SemanticEffectAdmissionRequest): Promise<ResolvedCommand> {
    let pending = this.admissions.get(request.path);
    if (!pending) {
      pending = this.resolveFresh(request);
      this.admissions.set(request.path, pending);
    }
    return pending;
  }

  private async resolveFresh(request: SemanticEffectAdmissionRequest): Promise<ResolvedCommand> {
    const options = commandOptions(request.input);
    const profile = resolveCommandProfile(this.options.profiles, options.profile);
    const invocation = resolveCommandInvocation(profile, options.args, options.effect);
    let workspace = this.options.launchWorkspace.workspace as WorkspaceRef;
    let workspaceRoot = path.resolve(this.options.launchWorkspace.root);
    let cwd = path.resolve(this.options.launchWorkspace.cwd);
    let candidate: ResolvedCommand["candidate"];
    if (options.effect === "candidate") {
      if (!options.workspace) throw new TypeError("Candidate command requires a candidate workspace");
      const descriptor = describeOpaqueCandidateWorkspace(options.workspace);
      if (!descriptor || descriptor.runId !== request.run.runId) {
        throw new TypeError("Command workspace does not belong to this run");
      }
      const handle = await this.options.candidateManager.describe(options.workspace);
      workspace = handle.ref;
      workspaceRoot = handle.root;
      cwd = handle.cwd;
      candidate = { capability: options.workspace, handle };
    }
    return {
      options,
      profile,
      invocation,
      workspace,
      workspaceRoot,
      cwd,
      ...(candidate ? { candidate } : {}),
      semanticInput: {
        profileId: profile.id,
        profileHash: profile.hash,
        invocationHash: invocation.hash,
        effect: options.effect,
        output: options.output,
        allowFailure: options.allowFailure,
        workspace: workspace.kind === "snapshot"
          ? { kind: "snapshot", treeHash: workspace.treeHash }
          : {
              kind: "candidate",
              treeHash: workspace.treeHash,
              lineageHash: workspace.lineageHash!,
              writeScopeHash: workspace.writeScopeHash!,
            },
      } as unknown as JsonValue,
    };
  }

  private admitAttempt(request: SemanticEffectRequest, resolved: ResolvedCommand): AttemptRecord {
    const suffix = stableHash({
      formatVersion: 1,
      runId: request.run.runId,
      operationId: request.operation.operationId,
      effect: "command",
    }).slice(7, 39);
    const attemptId = `attempt_${suffix}`;
    const existing = request.database.readAttempt(attemptId);
    if (existing) return existing;
    const at = this.timestamp();
    return request.database.insertAttempt(request.database.readRun().revision, {
      attemptId,
      runId: request.run.runId,
      operationId: request.operation.operationId,
      number: 1,
      effect: "command",
      executionId: `command_${suffix}`,
      status: "running",
      preWorkspace: resolved.workspace,
      usage: zeroUsage(),
      outputArtifacts: [],
      startedAt: at,
      updatedAt: at,
    }, {
      type: "command-attempt-started",
      operationId: request.operation.operationId,
      attemptId,
      payload: { profileId: resolved.profile.id },
      at,
    });
  }

  private assertResult(resolved: ResolvedCommand, result: HostCommandResult): void {
    if (!sameCommandExecutorProtocol(this.options.executor.describe(), result.executor)) {
      throw new Error("Command result came from another executor protocol");
    }
    if (stableJson(result.invocation) !== stableJson(resolved.invocation)) {
      throw new Error("Command executor ran a different reviewed invocation");
    }
    if (result.stdoutEvidence.digest !== stableHashBytes(result.stdout)
      || result.stderrEvidence.digest !== stableHashBytes(result.stderr)) {
      throw new Error("Command inline stream evidence is corrupt");
    }
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Command adapter clock is invalid");
    return value.toISOString();
  }
}

function commandOptions(value: unknown): CommandOptions {
  const record = plainRecord(value, "flow.command options");
  exactKeys(record, new Set(["title", "profile", "args", "effect", "workspace", "output", "allowFailure"]), "flow.command options");
  if (record.title !== undefined && (typeof record.title !== "string" || !record.title.trim())) {
    throw new TypeError("flow.command title is invalid");
  }
  if (typeof record.profile !== "string") throw new TypeError("flow.command profile must be a selector");
  const effect = record.effect ?? "read-only";
  if (effect !== "read-only" && effect !== "temporary" && effect !== "candidate") {
    throw new TypeError("flow.command effect is invalid");
  }
  if (effect === "candidate" ? record.workspace === undefined : record.workspace !== undefined) {
    throw new TypeError("flow.command workspace authority does not match its effect");
  }
  const output = record.output ?? "summary";
  if (output !== "summary" && output !== "stdout" && output !== "json") {
    throw new TypeError("flow.command output mode is invalid");
  }
  if (record.allowFailure !== undefined && typeof record.allowFailure !== "boolean") {
    throw new TypeError("flow.command allowFailure must be boolean");
  }
  const args = record.args === undefined ? {} : plainRecord(record.args, "flow.command args") as CommandArgumentValues;
  return {
    profile: record.profile,
    args: structuredClone(args),
    effect,
    output,
    allowFailure: record.allowFailure === true,
    ...(record.workspace !== undefined ? { workspace: record.workspace as CandidateWorkspaceCapability } : {}),
  };
}

function commandValue(options: CommandOptions, result: HostCommandResult, outputDigest: string): StoredCommandValue {
  const stdout = decodeUtf8(result.stdout, "command stdout");
  const stderr = decodeUtf8(result.stderr, "command stderr");
  let json: JsonValue | undefined;
  if (options.output === "json") {
    try { json = JSON.parse(stdout) as JsonValue; }
    catch (error) { throw new Error(`Command stdout is not JSON: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode ?? -1,
    durationMs: duration(result),
    output: options.output,
    ...(options.output === "stdout" ? { stdout } : {}),
    ...(options.output === "json" ? { json } : {}),
    ...(stderr ? { stderrPreview: Array.from(stderr).slice(0, 2_048).join("") } : {}),
    outputDigest,
  };
}

function parseStoredValue(value: unknown): StoredCommandValue {
  const record = plainRecord(value, "command operation result");
  if (typeof record.ok !== "boolean" || !Number.isSafeInteger(record.exitCode)
    || !Number.isSafeInteger(record.durationMs) || (record.durationMs as number) < 0
    || !["summary", "stdout", "json"].includes(String(record.output))
    || typeof record.outputDigest !== "string") {
    throw new Error("Command operation result is corrupt");
  }
  return structuredClone(record) as unknown as StoredCommandValue;
}

function duration(result: HostCommandResult): number {
  return Math.max(0, Date.parse(result.endedAt) - Date.parse(result.startedAt));
}

function decodeUtf8(value: Buffer, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw new Error(`${label} is not valid UTF-8`); }
}

function stableHashBytes(value: Buffer): string {
  return sha256(value);
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) throw new TypeError(`${label} contains unknown fields: ${extras.sort().join(", ")}`);
}

function assertContained(root: string, target: string, allowSame = false): void {
  const relative = path.relative(root, target);
  if ((!allowSame && relative === "") || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Command workspace path escapes its authority root");
  }
}
