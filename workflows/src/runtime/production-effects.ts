import fs from "node:fs";
import path from "node:path";
import type {
  AgentContextBundle,
  AgentExecutionRequest,
  AgentExecutor,
  AgentProfileSnapshot,
  AgentRouteSnapshot,
  AgentToolDescriptor,
  AgentWorkspaceHandle,
} from "../agents/executor.js";
import type { AgentProtocolServer } from "../agents/sdk-protocol-server.js";
import type { HostCommandExecutor, HostCommandResult } from "../commands/executor.js";
import type { CommandProfileSnapshot } from "../commands/profiles.js";
import { DEFINITION_LIMITS } from "../definition/limits.js";
import type { WorkflowAgentDescriptor } from "../definition/workflow-types.js";
import type { WorkflowRunDatabase } from "../persistence/run-database.js";
import type { JsonObject, JsonSchema, JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import type { VerificationProfileSnapshot, VerificationCommandGate } from "../verification/profiles.js";
import { verificationCommandProfile } from "../verification/environment.js";
import { scanCandidateTree } from "../candidates/tree.js";
import type {
  WorkflowAgentEffectExecutor,
  WorkflowAgentExecutionRequest,
  WorkflowApplyExecutor,
  WorkflowAskExecutor,
  WorkflowCommandEffectExecutor,
  WorkflowStaticEffectBinding,
  WorkflowVerificationExecutor,
} from "./effect-adapters.js";
import { WorkflowHumanSuspension } from "./semantic-engine.js";
import { scanProjectSource } from "../workspaces/project-snapshot.js";
import { withWorkflowApplyLock } from "../workspaces/apply-lock.js";

/** Production bridge from reviewed agent descriptors to the supervised SDK worker. */
export class WorkflowProductionAgentExecutor implements WorkflowAgentEffectExecutor {
  constructor(
    private readonly executor: AgentExecutor,
    private readonly protocol: AgentProtocolServer,
    private readonly launchWorkspace: { root: string; cwd: string; treeHash: string },
  ) {}

  async execute(request: WorkflowAgentExecutionRequest) {
    const authority = agentAuthority(request.binding);
    const executionId = request.attempt.executionId;
    if (!executionId) throw new Error("Workflow agent attempt lacks an execution id");
    const workspace: AgentWorkspaceHandle = request.workspace
      ? {
          mode: "candidate",
          root: request.workspace.root,
          cwd: request.workspace.cwd,
          preTreeHash: request.workspace.currentTreeHash,
          workspace: {
            kind: "candidate",
            workspaceId: request.workspace.record.workspaceId,
            treeHash: request.workspace.currentTreeHash,
            lineageHash: request.workspace.record.baseLineageHash,
            writeScopeHash: request.workspace.record.writeScopeHash,
          },
        }
      : {
          mode: "read-only",
          root: this.launchWorkspace.root,
          cwd: this.launchWorkspace.cwd,
          preTreeHash: this.launchWorkspace.treeHash,
          workspace: {
            kind: "snapshot",
            workspaceId: `snapshot_${this.launchWorkspace.treeHash.slice(7, 39)}`,
            treeHash: this.launchWorkspace.treeHash,
          },
        };
    const protocol = await this.protocol.authorize({
      executionId,
      operationId: request.operation.operationId,
      attemptId: request.attempt.attemptId,
      outputSchema: request.descriptor.output,
      workspace: { mode: workspace.mode === "candidate" ? "candidate" : "read-only", root: workspace.root, cwd: workspace.cwd },
      network: request.descriptor.network,
      signal: request.signal,
    });
    try {
      const settled = await this.protocol.finish(executionId);
      if (!settled) {
        const context: AgentContextBundle = { entries: [], hash: stableHash([]) };
        const prompt = [
          request.descriptor.instructions,
          request.prompt,
          "Finish by calling finish_work with exactly the requested structured result.",
        ].filter(Boolean).join("\n\n");
        const executionRequest: AgentExecutionRequest = {
          runId: request.run.runId,
          operationId: request.operation.operationId,
          operationPath: request.operation.path,
          attemptId: request.attempt.attemptId,
          executionId,
          profile: authority.profile,
          route: authority.route,
          tools: authority.tools,
          network: request.descriptor.network,
          outputSchema: request.descriptor.output,
          workspace,
          inputs: request.inputs,
          context,
          protocol,
          semanticCallKey: request.binding.hash,
          safety: request.run.safety,
          instruction: { kind: "initial-task", task: prompt },
          session: {
            agentSessionId: `session_${stableHash({ executionId }).slice(7, 39)}`,
            piSessionPath: `sessions/${executionId}/session.jsonl`,
            resume: false,
          },
        };
        const handle = await this.executor.start(executionRequest, { emit: async () => undefined });
        const outcome = await handle.wait();
        await handle.dispose?.();
        if (outcome.outcome !== "finished") {
          throw new Error(`Workflow agent ended ${outcome.outcome}${"reason" in outcome && outcome.reason ? `: ${outcome.reason.summary}` : ""}`);
        }
      }
      const finish = await this.protocol.finish(executionId);
      if (!finish || finish.value === undefined || typeof finish.value !== "object" || Array.isArray(finish.value)) {
        throw new Error("Workflow agent completed without its exact finish_work receipt");
      }
      return {
        finish: {
          receiptId: `${executionId}-${finish.toolCallId}`,
          outputSchemaHash: finish.schemaHash,
          output: finish.value as JsonObject,
        },
        published: await this.protocol.published(executionId),
      };
    } finally {
      this.protocol.revoke(executionId);
    }
  }
}

export class WorkflowProductionCommandExecutor implements WorkflowCommandEffectExecutor {
  constructor(
    private readonly runDir: string,
    private readonly executor: HostCommandExecutor,
    private readonly launchWorkspace: { root: string; cwd: string },
  ) {}

  async execute(request: Parameters<WorkflowCommandEffectExecutor["execute"]>[0]) {
    const authority = record(request.binding.authority, "command authority");
    const profile = authority.profile as unknown as CommandProfileSnapshot;
    if (!profile || profile.hash !== request.binding.authority.profileHash) throw new Error("Pinned command profile is corrupt");
    const root = request.workspace?.root ?? this.launchWorkspace.root;
    const cwd = request.workspace?.cwd ?? this.launchWorkspace.cwd;
    const started = Date.now();
    const result = await this.executor.execute({
      runId: request.run.runId,
      operationPath: request.operation.path,
      attempt: request.attempt.number,
      executionId: request.attempt.executionId!,
      runDir: this.runDir,
      workspaceRoot: root,
      cwd,
      profile,
      arguments: request.args,
      effect: request.descriptor.effect,
      safety: request.run.safety,
      maximumOutputBytes: Math.min(profile.outputLimitBytes, request.run.safety.outputBytes),
      inlineLimitBytes: Math.min(profile.outputLimitBytes, DEFINITION_LIMITS.commandInlineBytes),
    }, request.signal);
    return {
      ok: result.status === "completed" && result.exitCode === 0,
      exitCode: result.exitCode ?? -1,
      durationMs: duration(result, started),
      output: commandValue(request.descriptor.output, result),
      ...(result.stderr.length ? { stderrPreview: result.stderr.toString("utf8").slice(0, 8_000) } : {}),
      ...(result.resources ? { resources: JSON.parse(JSON.stringify(result.resources)) as JsonObject } : {}),
    };
  }
}

export class WorkflowProductionAskExecutor implements WorkflowAskExecutor {
  constructor(private readonly database: WorkflowRunDatabase, private readonly now: () => Date = () => new Date()) {}

  async ask(request: Parameters<WorkflowAskExecutor["ask"]>[0]) {
    const body = {
      kind: "ask",
      operationId: request.operation.operationId,
      prompt: request.prompt,
      ...(request.title ? { title: request.title } : {}),
      responseSchema: request.responseSchema,
    } as JsonObject;
    const challengeHash = stableHash(body);
    const interactionId = `interaction_${stableHash({ operationId: request.operation.operationId, challengeHash }).slice(7, 39)}`;
    let interaction = this.database.readHumanInteraction(interactionId);
    if (!interaction) interaction = this.database.requestHumanInteraction({
      expectedRevision: this.database.readRun().revision,
      interactionId,
      operationId: request.operation.operationId,
      kind: "ask",
      challengeHash,
      request: body,
      at: timestamp(this.now),
    });
    if (interaction.status === "answered" && interaction.response !== undefined) {
      return { response: structuredClone(interaction.response), approvalId: interaction.interactionId };
    }
    if (interaction.status !== "waiting") throw new Error(`Workflow ask interaction is ${interaction.status}`);
    throw new WorkflowHumanSuspension(interaction.interactionId, {
      category: "human", code: "ask-waiting", summary: "Workflow is waiting for a human response",
      retryable: true, interactionId: interaction.interactionId,
    });
  }
}

export class WorkflowProductionVerificationExecutor implements WorkflowVerificationExecutor {
  constructor(
    private readonly runDir: string,
    private readonly command: HostCommandExecutor,
    private readonly agent: WorkflowProductionAgentExecutor,
  ) {}

  async verify(request: Parameters<WorkflowVerificationExecutor["verify"]>[0]) {
    const authority = record(request.binding.authority, "verification authority");
    const profile = authority.profile as unknown as VerificationProfileSnapshot;
    if (!profile || profile.hash !== request.binding.authority.profileHash) throw new Error("Pinned verification profile is corrupt");
    const evidence: JsonObject = {};
    const failures: string[] = [];
    const tree = await scanCandidateTree(request.workspace.root);
    if (tree.treeHash !== request.candidate.treeHash) {
      throw new Error("Frozen candidate tree changed before verification");
    }
    if (profile.diffInspection.requireChanges && request.candidate.changedPaths.length === 0) failures.push("candidate has no changes");
    if (request.candidate.changedPaths.length > profile.diffInspection.maximumChangedPaths) failures.push("too many changed paths");
    for (const changed of request.candidate.changedPaths) {
      const entry = tree.entries.find(value => value.path === changed);
      if (entry?.type === "file" && entry.bytes > profile.diffInspection.maximumFileBytes) failures.push(`${changed} is too large`);
      if (entry?.type === "file" && profile.diffInspection.forbidSecrets) {
        const text = await fs.promises.readFile(path.join(request.workspace.root, changed), "utf8");
        if (/(?:api[_-]?key|secret|private[_-]?key)\s*[:=]/iu.test(text)) failures.push(`${changed} resembles a secret`);
      }
    }
    evidence.tests = await this.runGate("tests", profile.tests, request, failures);
    evidence.diagnostics = await this.runGate("diagnostics", profile.diagnostics, request, failures);
    if ("profile" in profile.adversarialReview) {
      const reviewer = record(authority.reviewer, "verification reviewer authority");
      const descriptor: WorkflowAgentDescriptor = {
        kind: "agent-task",
        binding: "verificationReviewer",
        identity: {
          kind: "agent-task",
          sourceSite: "verification-reviewer",
          definitionHash: stableHash(reviewer),
        },
        profile: (reviewer.profile as any).id,
        output: reviewSchema(),
        workspace: "candidate",
        network: "none",
        instructions: profile.adversarialReview.instructions,
        location: { line: 1, column: 1 },
      };
      const reviewInputs = path.join(this.runDir, "sessions", request.operation.operationId, "review-inputs");
      await fs.promises.mkdir(reviewInputs, { recursive: true, mode: 0o700 });
      const result = await this.agent.execute({
        run: request.run,
        operation: request.operation,
        attempt: request.attempt,
        descriptor,
        binding: {
          selector: descriptor.profile,
          authority: reviewer,
          hash: stableHash({ selector: descriptor.profile, authority: reviewer }),
        },
        prompt: "Inspect the exact candidate workspace. Report passed only when it is safe, correct, scoped, and adequately tested.",
        artifacts: { entries: [], hash: stableHash([]) },
        inputs: { root: reviewInputs, entries: [], hash: stableHash([]) },
        workspace: request.workspace,
        signal: request.signal,
      });
      evidence.review = result.finish.output;
      if (result.finish.output.status !== "passed") failures.push(`adversarial review ${String(result.finish.output.status)}`);
    }
    return {
      status: failures.length ? "failed" as const : "passed" as const,
      environmentHash: String(authority.environmentHash),
      evidence: { ...evidence, failures },
    };
  }

  private async runGate(
    name: "tests" | "diagnostics",
    gate: VerificationCommandGate,
    request: Parameters<WorkflowVerificationExecutor["verify"]>[0],
    failures: string[],
  ): Promise<JsonValue> {
    if (!Array.isArray(gate)) return { notApplicable: gate.notApplicable };
    const results: JsonValue[] = [];
    for (const command of gate) {
      const profile = verificationCommandProfile((request.binding.authority.profile as any).id, name, command);
      const result = await this.command.execute({
        runId: request.run.runId,
        operationPath: `${request.operation.path}/${name}:${command.id}`,
        attempt: request.attempt.number,
        executionId: `verification_${stableHash({ operation: request.operation.operationId, name, id: command.id }).slice(7, 39)}`,
        runDir: this.runDir,
        workspaceRoot: request.workspace.root,
        cwd: request.workspace.cwd,
        profile,
        arguments: {},
        effect: "read-only",
        safety: request.run.safety,
        maximumOutputBytes: Math.min(profile.outputLimitBytes, request.run.safety.outputBytes),
        inlineLimitBytes: Math.min(profile.outputLimitBytes, DEFINITION_LIMITS.commandInlineBytes),
        unitKind: "verification",
      }, request.signal);
      const passed = result.status === "completed" && result.exitCode === 0;
      if (!passed) failures.push(`${name}:${command.id} failed`);
      results.push({ id: command.id, passed, status: result.status, exitCode: result.exitCode ?? null });
    }
    return results;
  }
}

export class WorkflowProductionApplyExecutor implements WorkflowApplyExecutor {
  constructor(
    private readonly database: WorkflowRunDatabase,
    private readonly sourceRoot: string,
    private readonly launchRoot: string,
    private readonly launchTreeHash: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async apply(request: Parameters<WorkflowApplyExecutor["apply"]>[0]) {
    let interaction = this.database.readHumanInteractionByOperation(request.operation.operationId);
    if (!interaction) {
      const live = await scanProjectSource(this.sourceRoot);
      const requestBody = {
        kind: "apply",
        operationId: request.operation.operationId,
        candidateId: request.candidate.candidateId,
        candidateTreeHash: request.candidate.treeHash,
        verificationBindingHash: request.verification.bindingHash,
        changedPaths: request.candidate.changedPaths,
        observedLiveTreeHash: live.treeHash,
      } as JsonObject;
      const challengeHash = stableHash(requestBody);
      const interactionId = `interaction_${stableHash({ operationId: request.operation.operationId, challengeHash }).slice(7, 39)}`;
      interaction = this.database.requestHumanInteraction({
        expectedRevision: this.database.readRun().revision,
        interactionId,
        operationId: request.operation.operationId,
        kind: "apply",
        challengeHash,
        request: requestBody,
        at: timestamp(this.now),
      });
    }
    if (interaction.status === "waiting") throw new WorkflowHumanSuspension(interaction.interactionId, {
      category: "human", code: "apply-waiting", summary: "Workflow is waiting for exact apply approval",
      retryable: true, interactionId: interaction.interactionId,
    });
    if (interaction.status === "rejected") throw new Error("Exact workflow apply was rejected by the human");
    if (interaction.status !== "approved") throw new Error(`Workflow apply interaction is ${interaction.status}`);

    await withWorkflowApplyLock(this.sourceRoot, request.signal, async () => {
      const candidateTree = await scanCandidateTree(request.workspace.root);
      if (candidateTree.treeHash !== request.candidate.treeHash) {
        throw new Error("Frozen candidate tree changed before apply");
      }
      await applyWorkflowCandidateTree({
        sourceRoot: this.sourceRoot,
        launchRoot: this.launchRoot,
        candidateRoot: request.workspace.root,
        expectedLaunchTreeHash: this.launchTreeHash,
        expectedCandidateTreeHash: request.candidate.treeHash,
        changedPaths: request.candidate.changedPaths,
        signal: request.signal,
      });
    });
    const receiptId = `apply_${stableHash({
      interactionId: interaction.interactionId,
      candidateId: request.candidate.candidateId,
      challengeHash: interaction.challengeHash,
    }).slice(7, 39)}`;
    const result = {
      receiptId,
      approvalId: interaction.interactionId,
      candidateId: request.candidate.candidateId,
      verificationBindingHash: request.verification.bindingHash,
      changedPaths: [...request.candidate.changedPaths],
    };
    return { ...result, authorityHash: stableHash({ ...result }) };
  }
}

function agentAuthority(binding: WorkflowStaticEffectBinding): {
  profile: AgentProfileSnapshot; route: AgentRouteSnapshot; tools: AgentToolDescriptor[];
} {
  const value = record(binding.authority, "agent authority");
  const profile = value.profile as AgentProfileSnapshot;
  const route = value.route as AgentRouteSnapshot;
  const tools = value.tools as AgentToolDescriptor[];
  if (!profile || !route || !Array.isArray(tools)
    || profile.hash !== value.profileHash || route.hash !== value.routeHash) {
    throw new Error("Pinned agent authority is corrupt");
  }
  return { profile, route, tools };
}

function commandValue(mode: "summary" | "text" | "json", result: HostCommandResult): JsonValue {
  if (mode === "summary") return { status: result.status, exitCode: result.exitCode ?? null };
  const text = result.stdout.toString("utf8");
  if (mode === "text") return text;
  try { return JSON.parse(text) as JsonValue; }
  catch { throw new Error("Command profile returned invalid JSON output"); }
}

function duration(result: HostCommandResult, fallbackStart: number): number {
  const start = Date.parse(result.startedAt); const end = Date.parse(result.endedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : Math.max(0, Date.now() - fallbackStart);
}

function reviewSchema(): JsonSchema {
  return {
    type: "object", additionalProperties: false, required: ["status", "summary"],
    properties: {
      status: { type: "string", enum: ["passed", "failed", "blocked"] },
      summary: { type: "string", minLength: 1, maxLength: 8_000 },
    },
  };
}

export async function applyWorkflowCandidateTree(options: {
  sourceRoot: string;
  launchRoot: string;
  candidateRoot: string;
  expectedLaunchTreeHash: string;
  expectedCandidateTreeHash: string;
  changedPaths: readonly string[];
  signal: AbortSignal;
}): Promise<void> {
  const [before, after] = await Promise.all([
    scanCandidateTree(options.launchRoot),
    scanCandidateTree(options.candidateRoot),
  ]);
  if (before.treeHash !== options.expectedLaunchTreeHash || after.treeHash !== options.expectedCandidateTreeHash) {
    throw new Error("Workflow apply source evidence changed");
  }
  const beforeEntries = new Map(before.entries.map(entry => [entry.path, entry]));
  const afterEntries = new Map(after.entries.map(entry => [entry.path, entry]));
  for (const entryPath of options.changedPaths) {
    const post = afterEntries.get(entryPath);
    if (post && post.type !== "directory") {
      const target = safePath(options.sourceRoot, entryPath);
      await assertSafeApplyAncestors(options.sourceRoot, target);
      await removeApplyTemporary(applyTemporaryPath(
        target,
        options.expectedCandidateTreeHash,
        entryPath,
      ));
    }
  }
  const live = await scanProjectSource(options.sourceRoot);
  if (live.treeHash === after.treeHash) return;
  const liveEntries = new Map(live.entries.map(entry => [entry.path, entry]));
  const changed = new Set(options.changedPaths);
  const outsidePaths = new Set([...beforeEntries.keys(), ...liveEntries.keys()]);
  for (const entryPath of outsidePaths) {
    if (!changed.has(entryPath) && !sameTreeEntry(liveEntries.get(entryPath), beforeEntries.get(entryPath))) {
      throw new Error(`Live project drifted outside apply scope at ${entryPath}`);
    }
  }
  for (const entryPath of changed) {
    const current = liveEntries.get(entryPath);
    const pre = beforeEntries.get(entryPath);
    const post = afterEntries.get(entryPath);
    if (current !== undefined && !sameTreeEntry(current, pre) && !sameTreeEntry(current, post)) {
      throw new Error(`Live project conflicts with apply at ${entryPath}`);
    }
  }
  const removals = [...changed].filter(entryPath => !afterEntries.has(entryPath))
    .sort((a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a));
  const dirtyDirectories = new Set<string>([path.resolve(options.sourceRoot)]);
  for (const entryPath of removals) {
    options.signal.throwIfAborted();
    const target = safePath(options.sourceRoot, entryPath);
    await assertSafeApplyAncestors(options.sourceRoot, target);
    await fs.promises.rm(target, { recursive: true, force: true });
    markApplyParents(dirtyDirectories, options.sourceRoot, path.dirname(target));
  }
  const additions = [...changed].filter(entryPath => afterEntries.has(entryPath))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  for (const entryPath of additions) {
    options.signal.throwIfAborted();
    const entry = afterEntries.get(entryPath)!;
    const target = safePath(options.sourceRoot, entryPath);
    const source = safePath(options.candidateRoot, entryPath);
    await assertSafeApplyAncestors(options.sourceRoot, target);
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await assertSafeApplyAncestors(options.sourceRoot, target);
    const current = await lstatOptional(target);
    if (entry.type === "directory") {
      if (current && (!current.isDirectory() || current.isSymbolicLink())) {
        await fs.promises.rm(target, { recursive: true, force: true });
      }
      await fs.promises.mkdir(target, { recursive: true, mode: entry.mode });
      await fs.promises.chmod(target, entry.mode);
      dirtyDirectories.add(target);
    } else {
      const temporary = applyTemporaryPath(target, options.expectedCandidateTreeHash, entryPath);
      await removeApplyTemporary(temporary);
      try {
        if (entry.type === "symlink") await fs.promises.symlink(entry.target, temporary);
        else {
          await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
          await fs.promises.chmod(temporary, entry.mode);
          await syncFile(temporary);
        }
        if (current?.isDirectory() && !current.isSymbolicLink()) {
          await fs.promises.rm(target, { recursive: true, force: true });
        }
        await fs.promises.rename(temporary, target);
      } catch (error) {
        await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }
    markApplyParents(dirtyDirectories, options.sourceRoot, path.dirname(target));
  }
  for (const directory of [...dirtyDirectories]
    .sort((left, right) => right.split(path.sep).length - left.split(path.sep).length)) {
    await syncDirectory(directory);
  }
  if ((await scanProjectSource(options.sourceRoot)).treeHash !== after.treeHash) {
    throw new Error("Live project differs from candidate after apply");
  }
}

function applyTemporaryPath(target: string, candidateTreeHash: string, entryPath: string): string {
  const suffix = stableHash({ candidateTreeHash, entryPath }).slice(7, 23);
  return path.join(path.dirname(target), `.${path.basename(target)}.pi-workflow-${suffix}.tmp`);
}

async function removeApplyTemporary(temporary: string): Promise<void> {
  const current = await lstatOptional(temporary);
  if (!current) return;
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) {
    throw new Error(`Workflow apply temporary path is unsafe: ${temporary}`);
  }
  await fs.promises.rm(temporary);
}

async function lstatOptional(target: string): Promise<fs.Stats | undefined> {
  try { return await fs.promises.lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function assertSafeApplyAncestors(rootInput: string, targetInput: string): Promise<void> {
  const root = path.resolve(rootInput);
  const target = path.resolve(targetInput);
  const relative = path.relative(root, path.dirname(target));
  if (relative === "") return;
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.promises.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Workflow apply ancestor is unsafe: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function markApplyParents(directories: Set<string>, rootInput: string, startInput: string): void {
  const root = path.resolve(rootInput);
  let current = path.resolve(startInput);
  while (current !== root) {
    directories.add(current);
    const parent = path.dirname(current);
    if (parent === current || path.relative(root, parent).startsWith("..")) break;
    current = parent;
  }
  directories.add(root);
}

async function syncFile(file: string): Promise<void> {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

function sameTreeEntry(
  left: Awaited<ReturnType<typeof scanCandidateTree>>["entries"][number] | undefined,
  right: Awaited<ReturnType<typeof scanCandidateTree>>["entries"][number] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return stableJson(left) === stableJson(right);
}

function safePath(rootInput: string, relative: string): string {
  const root = path.resolve(rootInput);
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error("Workflow apply path escapes project root");
  }
  return target;
}

function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, any>;
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Workflow host clock is invalid");
  return value.toISOString();
}
