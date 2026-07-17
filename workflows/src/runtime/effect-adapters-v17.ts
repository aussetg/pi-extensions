import { Ajv } from "ajv";
import path from "node:path";
import { canonicalJsonObject, canonicalJsonValue, deepFreezeJson } from "../definition/canonical-json.js";
import type {
  ParsedWorkflowV17,
  WorkflowV17AgentDescriptor,
  WorkflowV17CommandDescriptor,
  WorkflowV17Descriptor,
} from "../definition/workflow-v17-types.js";
import type {
  WorkflowArtifactV17Record,
  WorkflowAttemptV17Record,
  WorkflowCandidateMeasurementV17Record,
  WorkflowCandidateV17Record,
  WorkflowCandidateVerificationV17Record,
  WorkflowOperationV17Record,
  WorkflowRunV17Record,
} from "../persistence/run-database-v17-types.js";
import {
  WorkflowRunDatabaseV17,
  WorkflowRunDatabaseV17RevisionConflictError,
} from "../persistence/run-database-v17.js";
import type { JsonObject, JsonSchema, JsonValue } from "../types.js";
import {
  normalizeMeasurementProfile,
  type MeasurementProfileSnapshot,
} from "../measurements/profiles.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import { assertIdentifier } from "../persistence/run-database-codec.js";
import { zeroUsage } from "./durable-types.js";
import type {
  WorkflowV17EffectAdapterContext,
  WorkflowV17EffectIdentity,
  WorkflowV17EffectRestoreContext,
  WorkflowV17SemanticEffectAdapter,
} from "./semantic-engine-v17.js";
import { WorkflowV17EffectProductFactory } from "../artifacts/products-v17.js";
import { materializeWorkflowV17AgentInputs } from "../artifacts/agent-inputs-v17.js";
import type { AgentInputBundleHandle } from "../agents/executor.js";
import {
  workflowV17ArtifactManifestHash,
  type WorkflowV17ArtifactManifest,
} from "../artifacts/manifest-v17.js";
import {
  WorkflowV17CandidateRuntime,
  type WorkflowV17CandidateWorkspaceHandle,
} from "../candidates/runtime-v17.js";

const MAX_REVISION_RETRIES = 16;
const PROFILE = /^(?:builtin|user|project):[a-z][a-z0-9_-]{0,63}$/u;

export interface WorkflowV17StaticEffectBinding {
  selector: string;
  authority: JsonObject;
  hash: string;
}

export interface WorkflowV17StaticEffectResources {
  formatVersion: 1;
  definitionHash: string;
  agents: Record<string, WorkflowV17StaticEffectBinding>;
  commands: Record<string, WorkflowV17StaticEffectBinding>;
  verifications: Record<string, WorkflowV17StaticEffectBinding>;
  measurements: Record<string, {
    selector: string;
    profile: MeasurementProfileSnapshot;
    hash: string;
  }>;
  measurementRuntime?: {
    executor: JsonObject;
    executorHash: string;
    environment: JsonObject;
    environmentHash: string;
    hash: string;
  };
  hash: string;
}

export function workflowV17StaticEffectResources(input: {
  workflow: ParsedWorkflowV17;
  definitionHash: string;
  agents?: Record<string, { selector: string; authority: JsonObject }>;
  commands?: Record<string, { selector: string; authority: JsonObject }>;
  verifications?: Record<string, { selector: string; authority: JsonObject }>;
  measurements?: Record<string, MeasurementProfileSnapshot>;
  measurementRuntime?: { executor: JsonObject; environment: JsonObject };
}): WorkflowV17StaticEffectResources {
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.definitionHash)) {
    throw new TypeError("Workflow v17 static resource definition hash is invalid");
  }
  const agents = bindings(input.agents ?? {});
  const commands = bindings(input.commands ?? {});
  const verifications = bindings(input.verifications ?? {});
  const measurements = Object.fromEntries(Object.entries(input.measurements ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)).map(([selector, profile]) => {
      assertPinnedMeasurementProfile(profile, selector);
      return [selector, { selector, profile: structuredClone(profile), hash: stableHash({ selector, profile }) }];
    }));
  const measurementRuntime = input.measurementRuntime ? (() => {
    const executor = canonicalJsonObject(input.measurementRuntime!.executor, limits());
    const environment = canonicalJsonObject(input.measurementRuntime!.environment, limits());
    const value = {
      executor,
      executorHash: stableHash(executor),
      environment,
      environmentHash: stableHash(environment),
    };
    return { ...value, hash: stableHash(value) };
  })() : undefined;
  for (const descriptor of input.workflow.descriptors) {
    const table = descriptor.kind === "agent-task" ? agents : commands;
    const binding = table[descriptor.identity.sourceSite];
    if (!binding || binding.selector !== descriptor.profile) {
      throw new Error(`Workflow v17 descriptor ${descriptor.identity.sourceSite} lacks exact pinned ${descriptor.profile} authority`);
    }
    const required = descriptor.kind === "agent-task"
      ? ["profileHash", "routeHash"]
      : ["profileHash", "executorHash"];
    if (required.some(key => typeof binding.authority[key] !== "string"
      || !/^sha256:[a-f0-9]{64}$/u.test(binding.authority[key] as string))) {
      throw new Error(`Workflow v17 descriptor ${descriptor.identity.sourceSite} has invalid pinned hashes`);
    }
  }
  for (const site of Object.keys(agents)) requireDescriptor(input.workflow, site, "agent-task");
  for (const site of Object.keys(commands)) requireDescriptor(input.workflow, site, "command-task");
  for (const profile of input.workflow.review.verificationProfiles) {
    if (!verifications[profile] || verifications[profile]!.selector !== profile) {
      throw new Error(`Workflow v17 verification profile ${profile} lacks pinned authority`);
    }
    const authority = verifications[profile]!.authority;
    if (typeof authority.profileHash !== "string" || typeof authority.environmentHash !== "string"
      || !/^sha256:[a-f0-9]{64}$/u.test(authority.profileHash)
      || !/^sha256:[a-f0-9]{64}$/u.test(authority.environmentHash)) {
      throw new Error(`Workflow v17 verification profile ${profile} has invalid pinned hashes`);
    }
  }
  const expectedMeasurements = [...input.workflow.review.measurementProfiles].sort();
  if (Object.keys(measurements).sort().join("\0") !== expectedMeasurements.join("\0")) {
    throw new Error("Workflow v17 static measurement profile surface differs from review");
  }
  const usesMeasurements = input.workflow.operations.some(site => site.method === "measure");
  if (usesMeasurements !== Boolean(measurementRuntime)) {
    throw new Error(usesMeasurements
      ? "Workflow v17 measurement runtime authority is required"
      : "Workflow v17 measurement runtime authority is unused");
  }
  const body = {
    formatVersion: 1 as const,
    definitionHash: input.definitionHash,
    agents,
    commands,
    verifications,
    measurements,
    ...(measurementRuntime ? { measurementRuntime } : {}),
  };
  return deepFreezeJson({ ...body, hash: stableHash(body) } as unknown as JsonValue) as unknown as WorkflowV17StaticEffectResources;
}

export function assertWorkflowV17StaticEffectResources(
  workflow: ParsedWorkflowV17,
  resources: WorkflowV17StaticEffectResources,
): void {
  if (!resources || resources.formatVersion !== 1 || typeof resources.hash !== "string") {
    throw new TypeError("Workflow v17 static effect resources are invalid");
  }
  const { hash, ...body } = resources;
  if (stableHash(body) !== hash) throw new TypeError("Workflow v17 static effect resource hash is corrupt");
  const expectedAgents = workflow.descriptors.filter(value => value.kind === "agent-task")
    .map(value => value.identity.sourceSite).sort();
  const expectedCommands = workflow.descriptors.filter(value => value.kind === "command-task")
    .map(value => value.identity.sourceSite).sort();
  const expectedVerifications = [...workflow.review.verificationProfiles].sort();
  if (Object.keys(resources.agents).sort().join("\0") !== expectedAgents.join("\0")
    || Object.keys(resources.commands).sort().join("\0") !== expectedCommands.join("\0")
    || Object.keys(resources.verifications).sort().join("\0") !== expectedVerifications.join("\0")
    || Object.keys(resources.measurements ?? {}).sort().join("\0")
      !== [...workflow.review.measurementProfiles].sort().join("\0")) {
    throw new TypeError("Workflow v17 static effect resource surface differs from review");
  }
  for (const descriptor of workflow.descriptors) {
    const binding = (descriptor.kind === "agent-task" ? resources.agents : resources.commands)[
      descriptor.identity.sourceSite
    ];
    if (!binding || binding.selector !== descriptor.profile
      || binding.hash !== stableHash({ selector: binding.selector, authority: binding.authority })) {
      throw new TypeError(`Workflow v17 descriptor ${descriptor.identity.sourceSite} has invalid pinned authority`);
    }
    const required = descriptor.kind === "agent-task"
      ? ["profileHash", "routeHash"]
      : ["profileHash", "executorHash"];
    if (required.some(key => typeof binding.authority[key] !== "string"
      || !/^sha256:[a-f0-9]{64}$/u.test(binding.authority[key] as string))) {
      throw new TypeError(`Workflow v17 descriptor ${descriptor.identity.sourceSite} has invalid pinned hashes`);
    }
  }
  for (const selector of workflow.review.verificationProfiles) {
    const binding = resources.verifications[selector];
    if (!binding || binding.selector !== selector
      || binding.hash !== stableHash({ selector: binding.selector, authority: binding.authority })
      || typeof binding.authority.profileHash !== "string"
      || typeof binding.authority.environmentHash !== "string"
      || !/^sha256:[a-f0-9]{64}$/u.test(binding.authority.profileHash)
      || !/^sha256:[a-f0-9]{64}$/u.test(binding.authority.environmentHash)) {
      throw new TypeError(`Workflow v17 verification ${selector} has invalid pinned authority`);
    }
  }
  for (const selector of workflow.review.measurementProfiles) {
    const binding = resources.measurements[selector];
    if (!binding || binding.selector !== selector || binding.profile.id !== selector
      || binding.hash !== stableHash({ selector, profile: binding.profile })) {
      throw new TypeError(`Workflow v17 measurement ${selector} has invalid pinned authority`);
    }
    assertPinnedMeasurementProfile(binding.profile, selector);
  }
  const usesMeasurements = workflow.operations.some(site => site.method === "measure");
  if (usesMeasurements !== Boolean(resources.measurementRuntime)) {
    throw new TypeError("Workflow v17 measurement runtime authority differs from review");
  }
  if (resources.measurementRuntime) {
    const runtime = resources.measurementRuntime;
    if (stableHash(runtime.executor) !== runtime.executorHash
      || stableHash(runtime.environment) !== runtime.environmentHash
      || stableHash({
        executor: runtime.executor,
        executorHash: runtime.executorHash,
        environment: runtime.environment,
        environmentHash: runtime.environmentHash,
      }) !== runtime.hash) {
      throw new TypeError("Workflow v17 measurement runtime authority is corrupt");
    }
  }
}

function assertPinnedMeasurementProfile(profile: MeasurementProfileSnapshot, selector: string): void {
  if (!profile || profile.id !== selector || profile.id !== `${profile.namespace}:${profile.name}`
    || typeof profile.path !== "string" || typeof profile.hash !== "string") {
    throw new TypeError(`Workflow v17 measurement profile ${selector} identity is invalid`);
  }
  const { id: _id, namespace, path: profilePath, hash, ...definition } = profile;
  const normalized = normalizeMeasurementProfile(definition, profilePath);
  if (stableJson(normalized) !== stableJson(definition)
    || stableHash({ namespace, definition }) !== hash) {
    throw new TypeError(`Workflow v17 measurement profile ${selector} snapshot is corrupt`);
  }
}

export interface WorkflowV17AgentExecutionRequest {
  run: WorkflowRunV17Record;
  operation: WorkflowOperationV17Record;
  attempt: WorkflowAttemptV17Record;
  descriptor: WorkflowV17AgentDescriptor;
  binding: WorkflowV17StaticEffectBinding;
  prompt: string;
  artifacts: WorkflowV17ArtifactManifest;
  inputs: AgentInputBundleHandle;
  workspace?: WorkflowV17CandidateWorkspaceHandle;
  signal: AbortSignal;
}

export interface WorkflowV17AgentExecutionResult {
  finish: {
    receiptId: string;
    outputSchemaHash: string;
    output: JsonObject;
  };
  published?: WorkflowArtifactV17Record[];
  usage?: JsonObject;
  resources?: JsonObject;
}

export interface WorkflowV17AgentEffectExecutor {
  execute(request: WorkflowV17AgentExecutionRequest): Promise<WorkflowV17AgentExecutionResult>;
}

export interface WorkflowV17CommandExecutionRequest {
  run: WorkflowRunV17Record;
  operation: WorkflowOperationV17Record;
  attempt: WorkflowAttemptV17Record;
  descriptor: WorkflowV17CommandDescriptor;
  binding: WorkflowV17StaticEffectBinding;
  args: Record<string, string | number | boolean>;
  workspace?: WorkflowV17CandidateWorkspaceHandle;
  signal: AbortSignal;
}

export interface WorkflowV17CommandExecutionResult {
  ok: boolean;
  exitCode: number;
  durationMs: number;
  output: JsonValue;
  stderrPreview?: string;
  usage?: JsonObject;
  resources?: JsonObject;
}

export interface WorkflowV17CommandEffectExecutor {
  execute(request: WorkflowV17CommandExecutionRequest): Promise<WorkflowV17CommandExecutionResult>;
}

export interface WorkflowV17AskExecutor {
  ask(request: {
    run: WorkflowRunV17Record;
    operation: WorkflowOperationV17Record;
    prompt: string;
    title?: string;
    responseSchema: JsonSchema;
    signal: AbortSignal;
  }): Promise<{ response: JsonValue; approvalId: string }>;
}

export interface WorkflowV17VerificationExecutor {
  verify(request: {
    run: WorkflowRunV17Record;
    operation: WorkflowOperationV17Record;
    attempt: WorkflowAttemptV17Record;
    candidate: WorkflowCandidateV17Record;
    workspace: WorkflowV17CandidateWorkspaceHandle;
    binding: WorkflowV17StaticEffectBinding;
    signal: AbortSignal;
  }): Promise<{
    status: "passed" | "failed" | "blocked";
    environmentHash: string;
    evidence: JsonObject;
    usage?: JsonObject;
    resources?: JsonObject;
  }>;
}

export interface WorkflowV17ApplyExecutor {
  apply(request: {
    run: WorkflowRunV17Record;
    operation: WorkflowOperationV17Record;
    attempt: WorkflowAttemptV17Record;
    candidate: WorkflowCandidateV17Record;
    workspace: WorkflowV17CandidateWorkspaceHandle;
    verification: WorkflowCandidateVerificationV17Record;
    signal: AbortSignal;
  }): Promise<{
    receiptId: string;
    approvalId: string;
    candidateId: string;
    verificationBindingHash: string;
    authorityHash: string;
    changedPaths: string[];
    usage?: JsonObject;
    resources?: JsonObject;
  }>;
}

export interface WorkflowV17MeasurementAuthorityResolver {
  resolve(value: unknown, candidate: WorkflowCandidateV17Record): WorkflowCandidateMeasurementV17Record;
}

interface AdapterOptions {
  database: WorkflowRunDatabaseV17;
  products: WorkflowV17EffectProductFactory;
  candidates: WorkflowV17CandidateRuntime;
  workflow: ParsedWorkflowV17;
  resources: WorkflowV17StaticEffectResources;
  now?: () => Date;
}

interface AgentInput {
  descriptorSourceSite: string;
  prompt: string;
  artifacts: WorkflowV17ArtifactManifest;
  workspace?: object;
}

interface StoredAgentResult {
  formatVersion: 1;
  authorityId: string;
  finishReceiptId: string;
  output: JsonObject;
  artifactDigest: string;
  publishedDigests: string[];
  checkpointArtifactDigest?: string;
}

export class WorkflowV17AgentEffectAdapter implements WorkflowV17SemanticEffectAdapter {
  readonly kind = "agent" as const;
  private readonly now: () => Date;
  private readonly resolved = new Map<string, ReturnType<WorkflowV17AgentEffectAdapter["resolve"]>>();

  constructor(private readonly options: AdapterOptions & { executor: WorkflowV17AgentEffectExecutor }) {
    this.now = options.now ?? (() => new Date());
  }

  semanticInput(context: Omit<WorkflowV17EffectAdapterContext, "semanticInput" | "operation">): JsonValue {
    return this.resolve(context.input).semanticInput;
  }

  async journalIdentity(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): Promise<WorkflowV17EffectIdentity> {
    const resolved = this.resolve(context.input);
    this.resolved.set(context.operation.operationId, resolved);
    if (!resolved.workspace) return identity("agent", resolved.semanticInput, context.run, "finish-work", "immutable");
    const workspace = await this.options.candidates.workspaceHandle(resolved.workspace);
    return {
      ...identity("agent", resolved.semanticInput, context.run, "finish-work", "workspace"),
      workspace: {
        workspaceId: workspace.record.workspaceId,
        lineageHash: workspace.record.baseLineageHash,
        expectedPreTreeHash: workspace.currentTreeHash,
      },
      postWorkspaceCheckpointId: this.options.candidates.checkpointId(resolved.workspace, context.operation),
    };
  }

  async execute(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): Promise<JsonValue> {
    const resolved = this.resolved.get(context.operation.operationId) ?? this.resolve(context.input);
    const attempt = await admitAttempt(this.options.database, context.operation, "agent", this.now);
    try {
      const workspace = resolved.workspace
        ? await this.options.candidates.workspaceHandle(resolved.workspace)
        : undefined;
      const inputs = await materializeWorkflowV17AgentInputs({
        store: this.options.products.store,
        root: path.join(this.options.products.store.runDir, "sessions", context.operation.operationId, "inputs"),
        manifest: resolved.artifacts,
      });
      const executed = await this.options.executor.execute({
        run: context.run,
        operation: context.operation,
        attempt,
        descriptor: resolved.descriptor,
        binding: resolved.binding,
        prompt: resolved.prompt,
        artifacts: resolved.artifacts,
        inputs,
        ...(workspace ? { workspace } : {}),
        signal: context.signal,
      });
      if (executed.finish?.outputSchemaHash !== stableHash(resolved.descriptor.output)) {
        throw new Error("Workflow v17 agent completion lacks its exact finish receipt");
      }
      boundedText(executed.finish.receiptId, "agent finish receipt", 512);
      validateSchema(resolved.descriptor.output, executed.finish.output, "agent output");
      const published = (executed.published ?? []).map(record => this.options.products.artifact(record));
      let checkpointArtifact: object | undefined;
      if (resolved.workspace) {
        const checkpoint = await this.options.candidates.checkpoint(resolved.workspace, context.operation);
        checkpointArtifact = this.options.products.artifact((await this.options.products.store.putJson({
          kind: "workspace-checkpoint",
          value: {
            formatVersion: 1,
            checkpointId: checkpoint.checkpointId,
            workspaceId: checkpoint.workspaceId,
            treeHash: checkpoint.treeHash,
            lineageHash: checkpoint.lineageHash ?? null,
            writeScopeHash: checkpoint.writeScopeHash ?? null,
          },
        })).record);
      }
      const authorityId = `agent-${context.operation.operationId.slice(-40).replace(/[^a-z0-9-]/gu, "-")}`;
      const product = await this.options.products.agentResult({
        authorityId,
        output: executed.finish.output,
        published,
        ...(checkpointArtifact ? { checkpoint: checkpointArtifact } : {}),
      }) as { artifact: object };
      const result: StoredAgentResult = {
        formatVersion: 1,
        authorityId,
        finishReceiptId: executed.finish.receiptId,
        output: canonicalJsonObject(executed.finish.output, limits()),
        artifactDigest: this.options.products.artifactRecord(product.artifact).digest,
        publishedDigests: published.map(value => this.options.products.artifactRecord(value).digest),
        ...(checkpointArtifact ? {
          checkpointArtifactDigest: this.options.products.artifactRecord(checkpointArtifact).digest,
        } : {}),
      };
      await finishAttempt(this.options.database, attempt, "completed", executed.usage, executed.resources, this.now);
      return result as unknown as JsonValue;
    } catch (error) {
      await finishAttempt(this.options.database, attempt, "failed", undefined, undefined, this.now).catch(() => undefined);
      throw error;
    }
  }

  evidence(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record; result: JsonValue }) {
    const result = storedAgent(context.result);
    const resolved = this.resolved.get(context.operation.operationId) ?? this.resolve(context.input);
    const inputs = resolved.artifacts.entries.map((entry, ordinal) => ({
      role: "input" as const,
      name: entry.path,
      ordinal,
      artifact: entry.artifact,
    }));
    const outputs = artifactLinks(this.options.database, [result.artifactDigest]);
    const evidence = artifactLinks(this.options.database, [
      ...result.publishedDigests,
      ...(result.checkpointArtifactDigest ? [result.checkpointArtifactDigest] : []),
    ]).map((link, ordinal) => ({ ...link, role: "evidence" as const, ordinal }));
    return { artifacts: [...inputs, ...outputs, ...evidence] };
  }

  async restore(context: WorkflowV17EffectRestoreContext): Promise<unknown> {
    const result = storedAgent(context.result);
    const published = result.publishedDigests.map(digest => this.artifact(digest));
    const checkpoint = result.checkpointArtifactDigest ? this.artifact(result.checkpointArtifactDigest) : undefined;
    return await this.options.products.agentResult({
      authorityId: result.authorityId,
      output: result.output,
      published,
      ...(checkpoint ? { checkpoint } : {}),
    });
  }

  private artifact(digest: string): object {
    const record = this.options.database.readArtifact(digest);
    if (!record) throw new Error(`Workflow v17 agent result artifact ${digest} is unavailable`);
    return this.options.products.artifact(record);
  }

  private resolve(value: unknown) {
    const input = plainRecord(value, "workflow v17 agent input") as unknown as AgentInput;
    exactKeys(input as unknown as object, ["descriptorSourceSite", "prompt", "artifacts", "workspace"], "workflow v17 agent input", true);
    const descriptor = requireDescriptor(this.options.workflow, input.descriptorSourceSite, "agent-task");
    const binding = this.options.resources.agents[input.descriptorSourceSite];
    if (!binding || binding.selector !== descriptor.profile) throw new Error("Workflow v17 agent binding is unavailable");
    const prompt = boundedText(input.prompt, "agent prompt", 128 * 1024);
    assertManifest(input.artifacts);
    if ((descriptor.workspace === "candidate") !== Boolean(input.workspace)) {
      throw new TypeError(`Workflow v17 ${descriptor.binding} workspace class differs from its invocation`);
    }
    const workspace = input.workspace;
    const workspaceSemantic = workspace ? workspaceAuthority(this.options.candidates, workspace) : undefined;
    return {
      descriptor,
      binding,
      prompt,
      artifacts: input.artifacts,
      ...(workspace ? { workspace } : {}),
      semanticInput: canonicalJsonValue({
        formatVersion: 1,
        descriptorSourceSite: descriptor.identity.sourceSite,
        descriptorHash: descriptor.identity.definitionHash,
        bindingHash: binding.hash,
        prompt,
        artifactManifestHash: input.artifacts.hash,
        ...(workspaceSemantic ? { workspace: workspaceSemantic } : {}),
      }, limits()),
    };
  }
}

interface CommandInput {
  descriptorSourceSite: string;
  args: Record<string, string | number | boolean>;
  workspace?: object;
}

interface StoredCommandResult {
  formatVersion: 1;
  authorityId: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  output: JsonValue;
  stderrPreview?: string;
  artifactDigest: string;
  checkpointId?: string;
}

export class WorkflowV17CommandEffectAdapter implements WorkflowV17SemanticEffectAdapter {
  readonly kind = "command" as const;
  private readonly now: () => Date;
  private readonly resolved = new Map<string, ReturnType<WorkflowV17CommandEffectAdapter["resolve"]>>();

  constructor(private readonly options: AdapterOptions & { executor: WorkflowV17CommandEffectExecutor }) {
    this.now = options.now ?? (() => new Date());
  }

  semanticInput(context: Omit<WorkflowV17EffectAdapterContext, "semanticInput" | "operation">): JsonValue {
    return this.resolve(context.input).semanticInput;
  }

  async journalIdentity(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): Promise<WorkflowV17EffectIdentity> {
    const resolved = this.resolve(context.input);
    this.resolved.set(context.operation.operationId, resolved);
    if (!resolved.workspace) return identity("command", resolved.semanticInput, context.run, "host-effect", "immutable");
    const workspace = await this.options.candidates.workspaceHandle(resolved.workspace);
    return {
      ...identity("command", resolved.semanticInput, context.run, "host-effect", "workspace"),
      workspace: {
        workspaceId: workspace.record.workspaceId,
        lineageHash: workspace.record.baseLineageHash,
        expectedPreTreeHash: workspace.currentTreeHash,
      },
      postWorkspaceCheckpointId: this.options.candidates.checkpointId(resolved.workspace, context.operation),
    };
  }

  async execute(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): Promise<JsonValue> {
    const resolved = this.resolved.get(context.operation.operationId) ?? this.resolve(context.input);
    const attempt = await admitAttempt(this.options.database, context.operation, "command", this.now);
    try {
      const workspace = resolved.workspace
        ? await this.options.candidates.workspaceHandle(resolved.workspace)
        : undefined;
      const executed = await this.options.executor.execute({
        run: context.run, operation: context.operation, attempt,
        descriptor: resolved.descriptor, binding: resolved.binding, args: resolved.args,
        ...(workspace ? { workspace } : {}), signal: context.signal,
      });
      if (!executed.ok && !resolved.descriptor.allowFailure) {
        throw new Error(`Workflow v17 command ${resolved.descriptor.profile} exited ${executed.exitCode}`);
      }
      const output = commandOutput(resolved.descriptor, executed);
      let checkpointId: string | undefined;
      if (resolved.workspace) checkpointId = (await this.options.candidates.checkpoint(
        resolved.workspace, context.operation,
      )).checkpointId;
      const authorityId = `command-${context.operation.operationId.slice(-40).replace(/[^a-z0-9-]/gu, "-")}`;
      const product = await this.options.products.commandResult({ authorityId, ...executed, output }) as { artifact: object };
      const result: StoredCommandResult = {
        formatVersion: 1,
        authorityId,
        ok: executed.ok,
        exitCode: executed.exitCode,
        durationMs: executed.durationMs,
        output,
        ...(executed.stderrPreview !== undefined ? { stderrPreview: executed.stderrPreview } : {}),
        artifactDigest: this.options.products.artifactRecord(product.artifact).digest,
        ...(checkpointId ? { checkpointId } : {}),
      };
      await finishAttempt(this.options.database, attempt, "completed", executed.usage, executed.resources, this.now);
      return result as unknown as JsonValue;
    } catch (error) {
      await finishAttempt(this.options.database, attempt, "failed", undefined, undefined, this.now).catch(() => undefined);
      throw error;
    }
  }

  evidence(context: WorkflowV17EffectAdapterContext & { result: JsonValue }) {
    return { artifacts: artifactLinks(this.options.database, [storedCommand(context.result).artifactDigest]) };
  }

  async restore(context: WorkflowV17EffectRestoreContext): Promise<unknown> {
    const result = storedCommand(context.result);
    return await this.options.products.commandResult(result);
  }

  private resolve(value: unknown) {
    const input = plainRecord(value, "workflow v17 command input") as unknown as CommandInput;
    exactKeys(input as unknown as object, ["descriptorSourceSite", "args", "workspace"], "workflow v17 command input", true);
    const descriptor = requireDescriptor(this.options.workflow, input.descriptorSourceSite, "command-task");
    const binding = this.options.resources.commands[input.descriptorSourceSite];
    if (!binding || binding.selector !== descriptor.profile) throw new Error("Workflow v17 command binding is unavailable");
    const args = scalarArguments(input.args);
    if ((descriptor.effect === "candidate") !== Boolean(input.workspace)) {
      throw new TypeError(`Workflow v17 ${descriptor.binding} workspace class differs from its invocation`);
    }
    const workspaceSemantic = input.workspace ? workspaceAuthority(this.options.candidates, input.workspace) : undefined;
    return {
      descriptor,
      binding,
      args,
      ...(input.workspace ? { workspace: input.workspace } : {}),
      semanticInput: canonicalJsonValue({
        formatVersion: 1,
        descriptorSourceSite: descriptor.identity.sourceSite,
        descriptorHash: descriptor.identity.definitionHash,
        bindingHash: binding.hash,
        args,
        ...(workspaceSemantic ? { workspace: workspaceSemantic } : {}),
      }, limits()),
    };
  }
}

interface AskInput { prompt: string; responseSchema: JsonSchema; title?: string }

export class WorkflowV17AskEffectAdapter implements WorkflowV17SemanticEffectAdapter {
  readonly kind = "ask" as const;
  constructor(private readonly options: AdapterOptions & { executor: WorkflowV17AskExecutor }) {}

  semanticInput(context: Omit<WorkflowV17EffectAdapterContext, "semanticInput" | "operation">): JsonValue {
    return askInput(context.input).semanticInput;
  }

  journalIdentity(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): WorkflowV17EffectIdentity {
    return identity("ask", context.semanticInput, context.run, "host-effect", "never");
  }

  async execute(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): Promise<JsonValue> {
    const input = askInput(context.input);
    const answered = await this.options.executor.ask({
      run: context.run, operation: context.operation, prompt: input.prompt,
      ...(input.title ? { title: input.title } : {}), responseSchema: input.responseSchema,
      signal: context.signal,
    });
    boundedText(answered.approvalId, "ask approval id", 512);
    validateSchema(input.responseSchema, answered.response, "ask response");
    return { formatVersion: 1, approvalId: answered.approvalId, response: answered.response };
  }

  restore(context: WorkflowV17EffectRestoreContext): unknown {
    const value = plainRecord(context.result, "workflow v17 ask result");
    exactKeys(value, ["formatVersion", "approvalId", "response"], "workflow v17 ask result");
    return structuredClone(value.response);
  }
}

interface VerificationInput { candidate: object; profile: string }
interface StoredVerification {
  formatVersion: 1;
  authorityId: string;
  verificationId: string;
  candidateId: string;
  status: "passed" | "failed" | "blocked";
  bindingHash: string;
  evidenceHash: string;
  evidence: JsonObject;
  artifactDigest: string;
}

export class WorkflowV17VerificationEffectAdapter implements WorkflowV17SemanticEffectAdapter {
  readonly kind = "verify" as const;
  private readonly now: () => Date;
  constructor(private readonly options: AdapterOptions & { executor: WorkflowV17VerificationExecutor }) {
    this.now = options.now ?? (() => new Date());
  }

  semanticInput(context: Omit<WorkflowV17EffectAdapterContext, "semanticInput" | "operation">): JsonValue {
    return this.resolve(context.input).semanticInput;
  }

  journalIdentity(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): WorkflowV17EffectIdentity {
    return identity("verify", context.semanticInput, context.run, "host-effect", "immutable");
  }

  async execute(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): Promise<JsonValue> {
    const resolved = this.resolve(context.input);
    if (resolved.candidate.state !== "pending") throw new Error(`Candidate ${resolved.candidate.candidateId} is ${resolved.candidate.state}`);
    const attempt = await admitAttempt(this.options.database, context.operation, "verification", this.now);
    try {
      const executed = await this.options.executor.verify({
        run: context.run, operation: context.operation, attempt,
        candidate: resolved.candidate,
        workspace: await this.options.candidates.candidateWorkspaceHandle(resolved.candidate),
        binding: resolved.binding,
        signal: context.signal,
      });
      if (executed.environmentHash !== resolved.binding.authority.environmentHash) {
        throw new Error("Workflow v17 verification environment differs from its pinned authority");
      }
      if (!new Set(["passed", "failed", "blocked"]).has(executed.status)) {
        throw new TypeError("Workflow v17 verification status is invalid");
      }
      const evidenceHash = stableHash(executed.evidence);
      const bindingHash = stableHash({
        formatVersion: 1,
        candidateId: resolved.candidate.candidateId,
        treeHash: resolved.candidate.treeHash,
        lineageHash: resolved.candidate.lineageHash,
        writeScopeHash: resolved.candidate.writeScopeHash,
        profileBindingHash: resolved.binding.hash,
        environmentHash: executed.environmentHash,
        evidenceHash,
      });
      const verificationId = `verification_${stableHash({
        runId: context.run.runId,
        operationId: context.operation.operationId,
        candidateId: resolved.candidate.candidateId,
        bindingHash,
      }).slice(7, 39)}`;
      const authorityId = `verification-${verificationId.slice(-32)}`;
      const product = await this.options.products.verification({
        authorityId,
        receiptId: verificationId,
        status: executed.status,
        evidence: executed.evidence,
      }) as { artifact: object };
      const result: StoredVerification = {
        formatVersion: 1,
        authorityId,
        verificationId,
        candidateId: resolved.candidate.candidateId,
        status: executed.status,
        bindingHash,
        evidenceHash,
        evidence: canonicalJsonObject(executed.evidence, limits()),
        artifactDigest: this.options.products.artifactRecord(product.artifact).digest,
      };
      await finishAttempt(this.options.database, attempt, "completed", executed.usage, executed.resources, this.now);
      return result as unknown as JsonValue;
    } catch (error) {
      await finishAttempt(this.options.database, attempt, "failed", undefined, undefined, this.now).catch(() => undefined);
      throw error;
    }
  }

  evidence(context: WorkflowV17EffectAdapterContext & { result: JsonValue }) {
    return { artifacts: artifactLinks(this.options.database, [storedVerification(context.result).artifactDigest]) };
  }

  async restore(context: WorkflowV17EffectRestoreContext): Promise<unknown> {
    const result = storedVerification(context.result);
    const record = await registerVerification(this.options.database, {
      verificationId: result.verificationId,
      candidateId: result.candidateId,
      operationId: context.operation.operationId,
      status: result.status,
      bindingHash: result.bindingHash,
      evidenceHash: result.evidenceHash,
      artifactDigest: result.artifactDigest,
      createdAt: context.operation.endedAt ?? context.operation.updatedAt,
    });
    return await this.options.products.verification({
      authorityId: result.authorityId,
      receiptId: record.verificationId,
      status: record.status,
      evidence: result.evidence,
    });
  }

  private resolve(value: unknown) {
    const input = plainRecord(value, "workflow v17 verification input") as unknown as VerificationInput;
    exactKeys(input as unknown as object, ["candidate", "profile"], "workflow v17 verification input");
    if (typeof input.profile !== "string" || !PROFILE.test(input.profile)) {
      throw new TypeError("Workflow v17 verification profile is invalid");
    }
    const binding = this.options.resources.verifications[input.profile];
    if (!binding || binding.selector !== input.profile) throw new Error(`Verification profile ${input.profile} is not pinned`);
    const candidate = this.options.candidates.candidate(input.candidate);
    return {
      candidate,
      binding,
      semanticInput: canonicalJsonValue({
        formatVersion: 1,
        candidate: candidateAuthority(candidate),
        profile: input.profile,
        bindingHash: binding.hash,
      }, limits()),
    };
  }
}

interface DispositionInput {
  candidate: object;
  verification?: object;
  measurement?: object;
  reason?: string;
}

export class WorkflowV17AcceptEffectAdapter implements WorkflowV17SemanticEffectAdapter {
  readonly kind = "accept" as const;
  constructor(private readonly options: AdapterOptions & { measurements?: WorkflowV17MeasurementAuthorityResolver }) {}
  semanticInput(context: Omit<WorkflowV17EffectAdapterContext, "semanticInput" | "operation">): JsonValue {
    return this.resolve(context.input).semanticInput;
  }
  journalIdentity(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): WorkflowV17EffectIdentity {
    return identity("accept", context.semanticInput, context.run, "host-effect", "immutable");
  }
  execute(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): JsonValue {
    const value = this.resolve(context.input);
    if (value.candidate.state !== "pending") throw new Error(`Candidate ${value.candidate.candidateId} is ${value.candidate.state}`);
    return {
      formatVersion: 1,
      candidateId: value.candidate.candidateId,
      verificationId: value.verification.verificationId,
      ...(value.measurement ? { measurementId: value.measurement.measurementId } : {}),
    };
  }
  async restore(context: WorkflowV17EffectRestoreContext): Promise<unknown> {
    const value = this.resolve(context.input);
    const candidate = await revisionRetry(async () => this.options.database.disposeCandidate({
      expectedRevision: this.options.database.readRun().revision,
      candidateId: value.candidate.candidateId,
      operationId: context.operation.operationId,
      disposition: "accepted",
      verificationId: value.verification.verificationId,
      ...(value.measurement ? { measurementId: value.measurement.measurementId } : {}),
      at: context.operation.endedAt ?? context.operation.updatedAt,
    }));
    return this.options.candidates.acceptedValue(candidate);
  }
  private resolve(value: unknown) {
    const input = dispositionInput(value, false);
    const candidate = this.options.candidates.candidate(input.candidate);
    const verification = verificationAuthority(this.options, input.verification, candidate, true);
    const measurement = input.measurement && this.options.measurements
      ? this.options.measurements.resolve(input.measurement, candidate) : undefined;
    if (input.measurement && !measurement) throw new TypeError("Workflow v17 measurement authority is unavailable");
    return {
      candidate, verification, ...(measurement ? { measurement } : {}),
      semanticInput: canonicalJsonValue({
        formatVersion: 1, candidate: candidateAuthority(candidate),
        verification: verificationAuthoritySemantic(verification),
        ...(measurement ? { measurement: measurementSemantic(measurement) } : {}),
      }, limits()),
    };
  }
}

export class WorkflowV17RejectEffectAdapter implements WorkflowV17SemanticEffectAdapter {
  readonly kind = "reject" as const;
  constructor(private readonly options: AdapterOptions & { measurements?: WorkflowV17MeasurementAuthorityResolver }) {}
  semanticInput(context: Omit<WorkflowV17EffectAdapterContext, "semanticInput" | "operation">): JsonValue {
    return this.resolve(context.input).semanticInput;
  }
  journalIdentity(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): WorkflowV17EffectIdentity {
    return identity("reject", context.semanticInput, context.run, "host-effect", "immutable");
  }
  execute(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): JsonValue {
    const value = this.resolve(context.input);
    if (value.candidate.state !== "pending") throw new Error(`Candidate ${value.candidate.candidateId} is ${value.candidate.state}`);
    return {
      formatVersion: 1,
      receiptId: `rejection_${stableHash({ operationId: context.operation.operationId, semanticInput: value.semanticInput }).slice(7, 39)}`,
      candidateId: value.candidate.candidateId,
      changedPaths: value.candidate.changedPaths,
      reason: value.reason,
      ...(value.verification ? { verificationId: value.verification.verificationId } : {}),
      ...(value.measurement ? { measurementId: value.measurement.measurementId } : {}),
    };
  }
  async restore(context: WorkflowV17EffectRestoreContext): Promise<unknown> {
    const value = this.resolve(context.input);
    const result = plainRecord(context.result, "workflow v17 rejection result");
    await revisionRetry(async () => this.options.database.disposeCandidate({
      expectedRevision: this.options.database.readRun().revision,
      candidateId: value.candidate.candidateId,
      operationId: context.operation.operationId,
      disposition: "rejected",
      ...(value.verification ? { verificationId: value.verification.verificationId } : {}),
      ...(value.measurement ? { measurementId: value.measurement.measurementId } : {}),
      reason: reason("rejected", value.reason),
      at: context.operation.endedAt ?? context.operation.updatedAt,
    }));
    return deepFreezeJson({
      receiptId: result.receiptId as string,
      changedPaths: [...value.candidate.changedPaths],
      reason: value.reason,
    } as unknown as JsonValue);
  }
  private resolve(value: unknown) {
    const input = dispositionInput(value, true);
    const candidate = this.options.candidates.candidate(input.candidate);
    const verification = input.verification
      ? verificationAuthority(this.options, input.verification, candidate, false) : undefined;
    const measurement = input.measurement && this.options.measurements
      ? this.options.measurements.resolve(input.measurement, candidate) : undefined;
    if (input.measurement && !measurement) throw new TypeError("Workflow v17 measurement authority is unavailable");
    const rejectionReason = boundedText(input.reason, "candidate rejection reason", 8_000);
    return {
      candidate, reason: rejectionReason,
      ...(verification ? { verification } : {}), ...(measurement ? { measurement } : {}),
      semanticInput: canonicalJsonValue({
        formatVersion: 1, candidate: candidateAuthority(candidate), reason: rejectionReason,
        ...(verification ? { verification: verificationAuthoritySemantic(verification) } : {}),
        ...(measurement ? { measurement: measurementSemantic(measurement) } : {}),
      }, limits()),
    };
  }
}

interface ApplyInput { candidate: object }
interface StoredApply {
  formatVersion: 1;
  receiptId: string;
  approvalId: string;
  candidateId: string;
  verificationBindingHash: string;
  authorityHash: string;
  changedPaths: string[];
}

export class WorkflowV17ApplyEffectAdapter implements WorkflowV17SemanticEffectAdapter {
  readonly kind = "apply" as const;
  private readonly now: () => Date;
  constructor(private readonly options: AdapterOptions & { executor: WorkflowV17ApplyExecutor }) {
    this.now = options.now ?? (() => new Date());
  }
  semanticInput(context: Omit<WorkflowV17EffectAdapterContext, "semanticInput" | "operation">): JsonValue {
    return this.resolve(context.input).semanticInput;
  }
  journalIdentity(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): WorkflowV17EffectIdentity {
    return identity("apply", context.semanticInput, context.run, "host-effect", "never");
  }
  async execute(context: WorkflowV17EffectAdapterContext & { operation: WorkflowOperationV17Record }): Promise<JsonValue> {
    const resolved = this.resolve(context.input);
    const attempt = await admitAttempt(this.options.database, context.operation, "apply", this.now);
    try {
      const applied = await this.options.executor.apply({
        run: context.run, operation: context.operation, attempt,
        candidate: resolved.candidate,
        workspace: await this.options.candidates.candidateWorkspaceHandle(resolved.candidate),
        verification: resolved.verification,
        signal: context.signal,
      });
      assertIdentifier(applied.receiptId, "workflow v17 apply receipt id");
      assertIdentifier(applied.approvalId, "workflow v17 apply approval id");
      if (applied.candidateId !== resolved.candidate.candidateId
        || applied.verificationBindingHash !== resolved.verification.bindingHash
        || stableJson(applied.changedPaths) !== stableJson(resolved.candidate.changedPaths)
        || applied.authorityHash !== stableHash({
          formatVersion: 1,
          candidateId: applied.candidateId,
          approvalId: applied.approvalId,
          receiptId: applied.receiptId,
          verificationBindingHash: applied.verificationBindingHash,
          changedPaths: applied.changedPaths,
        })) {
        throw new Error("Workflow v17 apply executor returned stale or foreign authority");
      }
      await finishAttempt(this.options.database, attempt, "completed", applied.usage, applied.resources, this.now);
      return { formatVersion: 1, ...applied } as unknown as JsonValue;
    } catch (error) {
      await finishAttempt(this.options.database, attempt, "failed", undefined, undefined, this.now).catch(() => undefined);
      throw error;
    }
  }
  async restore(context: WorkflowV17EffectRestoreContext): Promise<unknown> {
    const applied = storedApply(context.result);
    const candidate = this.resolve(context.input).candidate;
    await revisionRetry(async () => this.options.database.recordCandidateApply(
      this.options.database.readRun().revision,
      {
        receiptId: applied.receiptId,
        candidateId: candidate.candidateId,
        operationId: context.operation.operationId,
        approvalId: applied.approvalId,
        verificationBindingHash: applied.verificationBindingHash,
        authorityHash: applied.authorityHash,
        appliedAt: context.operation.endedAt ?? context.operation.updatedAt,
      },
    ));
    return deepFreezeJson({
      applied: true,
      receiptId: applied.receiptId,
      changedPaths: [...applied.changedPaths],
    } as unknown as JsonValue);
  }
  private resolve(value: unknown) {
    const input = plainRecord(value, "workflow v17 apply input") as unknown as ApplyInput;
    exactKeys(input as unknown as object, ["candidate"], "workflow v17 apply input");
    const candidate = this.options.candidates.accepted(input.candidate);
    const verificationId = candidate.disposition!.verificationId!;
    const verification = this.options.database.readCandidateVerification(verificationId);
    if (!verification || verification.status !== "passed" || verification.candidateId !== candidate.candidateId) {
      throw new Error("Accepted candidate has no exact passed verification");
    }
    return {
      candidate, verification,
      semanticInput: canonicalJsonValue({
        formatVersion: 1, candidate: candidateAuthority(candidate),
        acceptanceAuthorityHash: candidate.disposition!.authorityHash,
        verification: verificationAuthoritySemantic(verification),
      }, limits()),
    };
  }
}

export function workflowV17VerificationRecord(
  options: Pick<AdapterOptions, "database" | "products">,
  value: unknown,
): WorkflowCandidateVerificationV17Record {
  const description = options.products.authority.describe(value);
  if (!description || description.family !== "product" || description.identity.kind !== "verification") {
    throw new TypeError("Value has no workflow v17 verification authority");
  }
  const receiptId = description.fields.receiptId;
  const artifact = description.fields.artifact;
  if (typeof receiptId !== "string" || !artifact) throw new TypeError("Verification product fields are invalid");
  const record = options.database.readCandidateVerification(receiptId);
  if (!record || options.products.artifactRecord(artifact).digest !== record.artifactDigest
    || description.fields.status !== record.status || description.fields.passed !== (record.status === "passed")) {
    throw new TypeError("Verification product is stale or differs from durable evidence");
  }
  return record;
}

function verificationAuthority(
  options: Pick<AdapterOptions, "database" | "products">,
  value: unknown,
  candidate: WorkflowCandidateV17Record,
  passed: boolean,
): WorkflowCandidateVerificationV17Record {
  const verification = workflowV17VerificationRecord(options, value);
  if (verification.candidateId !== candidate.candidateId || (passed && verification.status !== "passed")) {
    throw new TypeError(passed
      ? "Candidate acceptance requires exact passed verification"
      : "Verification belongs to another candidate");
  }
  return verification;
}

function identity(
  kind: string,
  semanticInput: JsonValue,
  run: WorkflowRunV17Record,
  completionAuthority: WorkflowV17EffectIdentity["completionAuthority"],
  replayPolicy: WorkflowV17EffectIdentity["replayPolicy"],
): WorkflowV17EffectIdentity {
  return {
    semanticKey: stableHash({
      formatVersion: 1,
      kind: `workflow-v17-${kind}`,
      semanticInput,
      contextIdentityHash: run.contextIdentityHash,
    }),
    completionAuthority,
    replayPolicy,
  };
}

function bindings(value: Record<string, { selector: string; authority: JsonObject }>): Record<string, WorkflowV17StaticEffectBinding> {
  const result: Record<string, WorkflowV17StaticEffectBinding> = {};
  for (const [site, binding] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (!PROFILE.test(binding.selector)) throw new TypeError(`Invalid workflow v17 pinned selector ${binding.selector}`);
    const authority = canonicalJsonObject(binding.authority, limits());
    result[site] = { selector: binding.selector, authority, hash: stableHash({ selector: binding.selector, authority }) };
  }
  return result;
}

function requireDescriptor<K extends WorkflowV17Descriptor["kind"]>(
  workflow: ParsedWorkflowV17,
  sourceSite: string,
  kind: K,
): Extract<WorkflowV17Descriptor, { kind: K }> {
  const descriptor = workflow.descriptors.find(value => value.identity.sourceSite === sourceSite);
  if (!descriptor || descriptor.kind !== kind) throw new TypeError(`Unknown workflow v17 ${kind} ${sourceSite}`);
  return descriptor as Extract<WorkflowV17Descriptor, { kind: K }>;
}

function candidateAuthority(candidate: WorkflowCandidateV17Record): JsonObject {
  return {
    candidateId: candidate.candidateId,
    treeHash: candidate.treeHash,
    lineageHash: candidate.lineageHash,
    writeScopeHash: candidate.writeScopeHash,
    outputHash: candidate.outputHash,
    changedPathsHash: stableHash(candidate.changedPaths),
  };
}

function workspaceAuthority(candidates: WorkflowV17CandidateRuntime, value: unknown): JsonObject {
  const workspace = candidates.workspace(value);
  return {
    workspaceId: workspace.workspaceId,
    initialTreeHash: workspace.initialTreeHash,
    baseLineageHash: workspace.baseLineageHash,
    writeScopeHash: workspace.writeScopeHash,
  };
}

function verificationAuthoritySemantic(value: WorkflowCandidateVerificationV17Record): JsonObject {
  return {
    verificationId: value.verificationId,
    candidateId: value.candidateId,
    status: value.status,
    bindingHash: value.bindingHash,
    evidenceHash: value.evidenceHash,
  };
}

function measurementSemantic(value: WorkflowCandidateMeasurementV17Record): JsonObject {
  return { measurementId: value.measurementId, candidateId: value.candidateId, bindingHash: value.bindingHash };
}

function dispositionInput(value: unknown, requireReason: boolean): DispositionInput {
  const input = plainRecord(value, "workflow v17 candidate disposition input") as unknown as DispositionInput;
  exactKeys(
    input as unknown as object,
    ["candidate", "verification", "measurement", ...(requireReason ? ["reason"] : [])],
    "workflow v17 candidate disposition input",
    true,
  );
  if (!input.candidate || (requireReason && typeof input.reason !== "string")) {
    throw new TypeError("Workflow v17 candidate disposition input is incomplete");
  }
  if (!requireReason && !input.verification) throw new TypeError("Workflow v17 acceptance requires verification");
  return input;
}

function askInput(value: unknown): AskInput & { semanticInput: JsonValue } {
  const input = plainRecord(value, "workflow v17 ask input");
  exactKeys(input, ["prompt", "responseSchema", "title"], "workflow v17 ask input", true);
  const prompt = boundedText(input.prompt, "ask prompt", 32_000);
  const title = input.title === undefined ? undefined : boundedText(input.title, "ask title", 512);
  const responseSchema = canonicalJsonObject(input.responseSchema, limits()) as JsonSchema;
  new Ajv({ strict: false, validateSchema: true }).compile(responseSchema);
  return {
    prompt,
    responseSchema,
    ...(title ? { title } : {}),
    semanticInput: canonicalJsonValue({ formatVersion: 1, prompt, responseSchema }, limits()),
  };
}

function scalarArguments(value: unknown): Record<string, string | number | boolean> {
  if (value === undefined) return {};
  const input = plainRecord(value, "workflow v17 command arguments");
  const result: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(input).sort()) {
    const entry = input[key];
    if (typeof entry !== "string" && typeof entry !== "boolean"
      && (typeof entry !== "number" || !Number.isFinite(entry) || Object.is(entry, -0))) {
      throw new TypeError(`Workflow v17 command argument ${key} is not scalar`);
    }
    result[key] = entry as string | number | boolean;
  }
  return result;
}

function commandOutput(
  descriptor: WorkflowV17CommandDescriptor,
  result: WorkflowV17CommandExecutionResult,
): JsonValue {
  if (typeof result.ok !== "boolean" || !Number.isSafeInteger(result.exitCode)
    || !Number.isFinite(result.durationMs) || result.durationMs < 0
    || (result.stderrPreview !== undefined && typeof result.stderrPreview !== "string")) {
    throw new TypeError("Workflow v17 command result is invalid");
  }
  if (descriptor.output === "summary") {
    return { ok: result.ok, exitCode: result.exitCode, durationMs: result.durationMs };
  }
  if (descriptor.output === "text" && typeof result.output !== "string") {
    throw new TypeError("Workflow v17 text command returned non-text output");
  }
  return canonicalJsonValue(result.output, limits());
}

async function admitAttempt(
  database: WorkflowRunDatabaseV17,
  operation: WorkflowOperationV17Record,
  effect: WorkflowAttemptV17Record["effect"],
  now: () => Date,
): Promise<WorkflowAttemptV17Record> {
  const attemptId = `attempt_${stableHash({ runId: operation.runId, operationId: operation.operationId, effect }).slice(7, 39)}`;
  const existing = database.readAttempt(attemptId);
  if (existing) return existing;
  return await revisionRetry(async () => database.insertAttempt(database.readRun().revision, {
    attemptId,
    runId: operation.runId,
    operationId: operation.operationId,
    number: 1,
    effect,
    executionId: `execution_${stableHash({ attemptId }).slice(7, 39)}`,
    status: "running",
    usage: zeroUsage() as unknown as JsonObject,
    createdAt: timestamp(now),
    updatedAt: timestamp(now),
  }));
}

async function finishAttempt(
  database: WorkflowRunDatabaseV17,
  attempt: WorkflowAttemptV17Record,
  status: "completed" | "failed",
  usage: JsonObject | undefined,
  resources: JsonObject | undefined,
  now: () => Date,
): Promise<WorkflowAttemptV17Record> {
  const current = database.readAttempt(attempt.attemptId);
  if (!current) throw new Error(`Workflow v17 attempt ${attempt.attemptId} disappeared`);
  if (current.status === status) return current;
  if (current.status !== "running" && current.status !== "waiting") {
    throw new Error(`Workflow v17 attempt ${attempt.attemptId} is ${current.status}`);
  }
  return await revisionRetry(async () => database.completeAttempt({
    expectedRevision: database.readRun().revision,
    attemptId: attempt.attemptId,
    status,
    usage: usage ?? zeroUsage() as unknown as JsonObject,
    ...(resources ? { resources } : {}),
    at: timestamp(now),
  }));
}

async function registerVerification(
  database: WorkflowRunDatabaseV17,
  value: Omit<WorkflowCandidateVerificationV17Record, "runId">,
): Promise<WorkflowCandidateVerificationV17Record> {
  return await revisionRetry(async () => database.registerCandidateVerification(database.readRun().revision, value));
}

function artifactLinks(database: WorkflowRunDatabaseV17, digests: readonly string[]) {
  return digests.map((digest, ordinal) => {
    const artifact = database.readArtifact(digest);
    if (!artifact) throw new Error(`Workflow v17 operation artifact ${digest} is unavailable`);
    return { role: ordinal === 0 ? "output" as const : "evidence" as const, ordinal, artifact };
  });
}

function assertManifest(value: WorkflowV17ArtifactManifest): void {
  if (!value || value.formatVersion !== 1 || !Array.isArray(value.entries)
    || value.hash !== workflowV17ArtifactManifestHash(value.entries)) {
    throw new TypeError("Workflow v17 agent artifact manifest is invalid");
  }
}

function storedAgent(value: JsonValue): StoredAgentResult {
  const result = plainRecord(value, "workflow v17 stored agent result") as unknown as StoredAgentResult;
  if (result.formatVersion !== 1 || typeof result.authorityId !== "string"
    || typeof result.finishReceiptId !== "string" || typeof result.artifactDigest !== "string"
    || !Array.isArray(result.publishedDigests) || !result.output || typeof result.output !== "object") {
    throw new Error("Workflow v17 stored agent result is invalid");
  }
  return result;
}

function storedCommand(value: JsonValue): StoredCommandResult {
  const result = plainRecord(value, "workflow v17 stored command result") as unknown as StoredCommandResult;
  if (result.formatVersion !== 1 || typeof result.authorityId !== "string" || typeof result.artifactDigest !== "string") {
    throw new Error("Workflow v17 stored command result is invalid");
  }
  return result;
}

function storedVerification(value: JsonValue): StoredVerification {
  const result = plainRecord(value, "workflow v17 stored verification") as unknown as StoredVerification;
  if (result.formatVersion !== 1 || typeof result.verificationId !== "string" || typeof result.artifactDigest !== "string") {
    throw new Error("Workflow v17 stored verification is invalid");
  }
  return result;
}

function storedApply(value: JsonValue): StoredApply {
  const result = plainRecord(value, "workflow v17 stored apply") as unknown as StoredApply;
  if (result.formatVersion !== 1 || typeof result.receiptId !== "string" || !Array.isArray(result.changedPaths)) {
    throw new Error("Workflow v17 stored apply result is invalid");
  }
  return result;
}

function validateSchema(schema: JsonSchema, value: unknown, label: string): void {
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new TypeError(`Invalid workflow v17 ${label}: ${ajv.errorsText(validate.errors)}`);
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Workflow v17 ${label} is invalid`);
  }
  return value;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  allowed: readonly string[],
  label: string,
  optional = false,
): void {
  const actual = Object.keys(value).sort();
  const permitted = new Set(allowed);
  if (actual.some(key => !permitted.has(key)) || (!optional && actual.length !== allowed.length)) {
    throw new TypeError(`${label} contains unexpected fields`);
  }
}

function reason(code: string, summary: string): JsonObject {
  return { category: "candidate", code, summary, retryable: false };
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("Workflow v17 effect clock is invalid");
  return value.toISOString();
}

async function revisionRetry<T>(body: () => T | Promise<T>): Promise<T> {
  for (let retry = 0; retry < MAX_REVISION_RETRIES; retry++) {
    try { return await body(); }
    catch (error) {
      if (error instanceof WorkflowRunDatabaseV17RevisionConflictError) continue;
      throw error;
    }
  }
  throw new Error("Workflow v17 effect lifecycle exceeded revision retries");
}

function limits() {
  return { maxBytes: 2 * 1024 * 1024, maxDepth: 48, maxNodes: 50_000, maxStringScalars: 200_000 };
}
