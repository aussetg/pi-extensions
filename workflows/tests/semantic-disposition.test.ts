import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SemanticApplyAdapter } from "../src/apply/semantic-adapter.js";
import { SemanticAcceptAdapter, SemanticRejectAdapter } from "../src/candidates/disposition-adapters.js";
import { SemanticCandidateAdapter } from "../src/candidates/semantic-adapter.js";
import { CandidateWorkspaceManager, type CandidateWorkspaceCapability } from "../src/candidates/store.js";
import { parseStructuredWorkflow } from "../src/definition/workflow-definition.js";
import { RunDatabase } from "../src/persistence/run-database.js";
import type { RunRecord } from "../src/runtime/durable-types.js";
import {
  executeSequentialSemanticRun,
  semanticInvocationHash,
  SemanticEngineCrashError,
  type SemanticEffectAdapter,
  type SemanticEffectAdmissionRequest,
  type SemanticEffectRequest,
  type SemanticEffectRestoreRequest,
  type SemanticEngineInvocation,
  type SemanticReplaySource,
} from "../src/runtime/semantic-engine.js";
import { sha256, stableHash } from "../src/utils/hashes.js";
import { stableJson } from "../src/utils/stable-json.js";
import { SemanticVerificationAdapter } from "../src/verification/semantic-adapter.js";
import { VerificationProfileRegistry, type VerificationProfileDefinition } from "../src/verification/profiles.js";
import { captureProjectSnapshot } from "../src/workspaces/project-snapshot.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeWritable(root);
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

describe("candidate, verification, disposition, and apply semantic effects", () => {
  it("runs produce → verify → accept → exact approval → apply and rejects a stale challenge", async () => {
    const fixture = await createFixture("apply");
    const waiting = await fixture.execute();
    expect(waiting.status).toBe("waiting");
    const apply = fixture.database.listOperations({ limit: 32 }).find((operation) => operation.kind === "apply")!;
    const plan = fixture.database.readApplyPlanByOperation(apply.operationId)!;
    const approval = fixture.database.readApproval(plan.approvalId)!;
    expect(approval.status).toBe("waiting");
    expect(await fs.promises.readFile(path.join(fixture.project, "value.txt"), "utf8")).toBe("launch\n");

    fixture.database.enqueueControlRequest({
      requestId: "request_wrong_apply",
      runId: fixture.runId,
      expectedRevision: fixture.database.readRun().revision,
      requestedAt: new Date().toISOString(),
      actor: "human:test",
      kind: "approve",
      approvalId: approval.approvalId,
      challengeHash: sha256("stale challenge"),
    });
    const stale = fixture.database.resolveApprovalControlRequest(
      fixture.database.readRun().revision,
      "request_wrong_apply",
      new Date().toISOString(),
    );
    expect(stale.acknowledgement).toMatchObject({ accepted: false, reason: { code: "challenge-mismatch" } });

    fixture.database.enqueueControlRequest({
      requestId: "request_exact_apply",
      runId: fixture.runId,
      expectedRevision: fixture.database.readRun().revision,
      requestedAt: new Date().toISOString(),
      actor: "human:test",
      kind: "approve",
      approvalId: approval.approvalId,
      challengeHash: approval.challenge.challengeHash,
    });
    const accepted = fixture.database.resolveApprovalControlRequest(
      fixture.database.readRun().revision,
      "request_exact_apply",
      new Date().toISOString(),
    );
    expect(accepted.acknowledgement.accepted).toBe(true);

    const completed = await fixture.execute();
    expect(completed).toMatchObject({
      status: "completed",
      result: { status: "applied", changedPaths: ["value.txt"] },
    });
    expect(await fs.promises.readFile(path.join(fixture.project, "value.txt"), "utf8")).toBe("candidate\n");
    expect(fixture.database.readApplyReceipt(plan.planId)).toMatchObject({ candidateId: expect.stringMatching(/^candidate_/) });
  });

  it("commits rejection only for the exact candidate and verification bindings", async () => {
    const fixture = await createFixture("reject");
    const outcome = await fixture.execute();
    expect(outcome).toMatchObject({
      status: "completed",
      result: { status: "rejected", reason: "policy rejected candidate", changedPaths: ["value.txt"] },
    });
    const rejection = fixture.database.listOperations({ limit: 32 }).find((operation) => operation.kind === "reject")!;
    expect(rejection.result?.artifacts).toHaveLength(1);
    expect(rejection.result?.artifacts[0]?.kind).toBe("candidate-disposition");
    expect(await fs.promises.readFile(path.join(fixture.project, "value.txt"), "utf8")).toBe("launch\n");
  });

  it("rechecks verification authority after human approval", async () => {
    const fixture = await createFixture("apply");
    expect((await fixture.execute()).status).toBe("waiting");
    const apply = fixture.database.listOperations({ limit: 32 }).find((operation) => operation.kind === "apply")!;
    const plan = fixture.database.readApplyPlanByOperation(apply.operationId)!;
    const approval = fixture.database.readApproval(plan.approvalId)!;
    fixture.database.enqueueControlRequest({
      requestId: "request_stale_authority",
      runId: fixture.runId,
      expectedRevision: fixture.database.readRun().revision,
      requestedAt: new Date().toISOString(),
      actor: "human:test",
      kind: "approve",
      approvalId: approval.approvalId,
      challengeHash: approval.challenge.challengeHash,
    });
    expect(fixture.database.resolveApprovalControlRequest(
      fixture.database.readRun().revision,
      "request_stale_authority",
      new Date().toISOString(),
    ).acknowledgement.accepted).toBe(true);

    fixture.currentVerificationBinding.gateEnvironmentHash = sha256("changed verification environment");
    const outcome = await fixture.execute();
    expect(outcome).toMatchObject({
      status: "failed",
      error: "Verification policy or required tool environment changed before apply; rerun affected gates",
    });
    expect(fixture.database.readApplyReceipt(plan.planId)).toBeUndefined();
    expect(await fs.promises.readFile(path.join(fixture.project, "value.txt"), "utf8")).toBe("launch\n");
  });

  it("recovers a crash after candidate freeze without rerunning a completed mutation", async () => {
    const fixture = await createFixture("reject");
    let crashed = false;
    await expect(fixture.execute({
      faultInjector: (point, operation) => {
        if (!crashed && point === "after-effect-settled" && operation?.kind === "candidate") {
          crashed = true;
          throw new SemanticEngineCrashError("crash after candidate freeze");
        }
      },
    })).rejects.toThrow(/candidate freeze/);
    expect(fixture.mutations.value).toBe(1);
    const recovered = await fixture.execute();
    expect(recovered.status).toBe("completed");
    expect(fixture.mutations.value).toBe(1);
    expect(fixture.database.listWorkspaceCheckpointIds()).toHaveLength(1);
  });

  it("replays the mutating child checkpoint and immutable verification/disposition prefix", async () => {
    const root = await temporaryRoot("replay-");
    const project = path.join(root, "project");
    await fs.promises.mkdir(project, { recursive: true });
    await fs.promises.writeFile(path.join(project, "value.txt"), "launch\n");
    const source = await createFixture("reject", { root, project });
    expect((await source.execute()).status).toBe("completed");
    const target = await createFixture("reject", { root, project, replaySource: source });
    const outcome = await target.execute();
    expect(outcome.status).toBe("completed");
    expect(target.mutations.value).toBe(0);
    expect(target.database.readRun().replay).toMatchObject({ matchedCalls: 3 });
    const replayed = target.database.listOperations({ limit: 32 }).filter((operation) => operation.replay);
    expect(replayed.map((operation) => operation.kind)).toEqual(["agent", "verify", "reject"]);
    const replayedVerification = replayed.find((operation) => operation.kind === "verify")!;
    const replayedReceipt = target.database.readVerificationByOperation(replayedVerification.operationId)!;
    expect(target.database.readAttempt(replayedReceipt.attemptId)?.status).toBe("completed");
    expect(await fs.promises.readFile(path.join(target.candidateRoot(), "value.txt"), "utf8")).toBe("candidate\n");
  });
});

interface FixtureOptions {
  root?: string;
  project?: string;
  replaySource?: { runId: string; runDir: string };
}

async function createFixture(mode: "apply" | "reject", options: FixtureOptions = {}) {
  const root = options.root ?? await temporaryRoot(`${mode}-`);
  const project = options.project ?? path.join(root, "project");
  if (!options.project) {
    await fs.promises.mkdir(project, { recursive: true });
    await fs.promises.writeFile(path.join(project, "value.txt"), "launch\n");
  }
  const parsed = parseStructuredWorkflow(workflowSource());
  const runId = `flow_${crypto.randomBytes(16).toString("hex")}`;
  const runDir = path.join(root, runId);
  for (const directory of [
    "context", "sessions", "workspaces/candidates", "workspaces/checkpoints",
    "workspaces/overlays", "artifacts", "outputs", "profiles",
  ]) await fs.promises.mkdir(path.join(runDir, directory), { recursive: true });
  const manifest = await captureProjectSnapshot(project, project, path.join(runDir, "context", "project"));
  await fs.promises.writeFile(path.join(runDir, "context", "project-manifest.json"), `${stableJson(manifest)}\n`);
  const definitionHash = stableHash({ sourceHash: parsed.sourceHash, metadata: parsed.metadata });
  const input = { mode };
  const invocation: SemanticEngineInvocation = {
    workflowId: "builtin:phase22-fixture",
    definitionHash,
    input,
    inputHash: stableHash(input),
  };
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId,
    revision: 1,
    workflow: {
      id: "builtin:phase22-fixture",
      name: parsed.metadata.name,
      sourceHash: parsed.sourceHash,
      definitionHash,
      capabilities: parsed.metadata.capabilities,
    },
    invocationHash: semanticInvocationHash(invocation),
    projectSnapshotHash: manifest.treeHash,
    routeSnapshotHash: sha256("phase22-routes"),
    contextIdentityHash: stableHash({ tree: manifest.treeHash, source: parsed.sourceHash }),
    status: "queued",
    safety: {
      concurrency: 2,
      maximumAgentLaunches: 20,
      memoryBytes: 512 * 1024 * 1024,
      tasks: 64,
      cpuQuotaPercent: 100,
      cpuWeight: 100,
      outputBytes: 8 * 1024 * 1024,
      commandTimeoutMs: 60_000,
    },
    usage: zeroUsage(),
    ...(options.replaySource ? {
      replay: {
        mode: "cross-revision-prefix",
        sourceRunId: options.replaySource.runId,
        matchedCalls: 0,
        fresh: false,
      } as const,
    } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const database = RunDatabase.create(path.join(runDir, "run.sqlite"), { run });
  const manager = await CandidateWorkspaceManager.open(runDir, database);
  const profiles = new VerificationProfileRegistry();
  await profiles.refresh(project, {
    userDir: path.join(runDir, "profiles"),
    builtins: [verificationProfile()],
  });
  const mutations = { value: 0 };
  const currentVerificationBinding: { profileHash?: string; gateEnvironmentHash?: string } = {};
  const adapters: SemanticEffectAdapter[] = [
    new SemanticCandidateAdapter({ manager }),
    mutationAdapter(manager, mutations),
    new SemanticVerificationAdapter({
      runDir,
      database,
      profiles: profiles.list(),
      evidence: {
        environmentIdentity: () => ({ fixture: "phase22-verification-v1" }),
        collect: async () => ({}),
      },
    }),
    new SemanticAcceptAdapter({ runDir, database }),
    new SemanticRejectAdapter({ runDir, database }),
    new SemanticApplyAdapter({
      runDir,
      database,
      currentVerificationBinding: (verification) => ({
        profileHash: currentVerificationBinding.profileHash ?? verification.profileHash,
        gateEnvironmentHash: currentVerificationBinding.gateEnvironmentHash ?? verification.gateEnvironmentHash,
      }),
    }),
  ];
  return {
    root,
    project,
    runId,
    runDir,
    database,
    manager,
    mutations,
    currentVerificationBinding,
    candidateRoot: () => {
      const workspace = database.listOperations({ limit: 32 }).find((operation) => operation.kind === "candidate")?.result?.value as any;
      const candidate = database.readCandidate(workspace.candidateId)!;
      return path.join(runDir, database.readCandidateWorkspace(candidate.workspace.workspaceId)!.rootPath);
    },
    execute: (
      engineOptions: Parameters<typeof executeSequentialSemanticRun>[5] = {},
    ): ReturnType<typeof executeSequentialSemanticRun> => executeSequentialSemanticRun(
      runDir,
      database,
      parsed,
      invocation,
      adapters,
      {
        controlPollIntervalMs: 5,
        ...(options.replaySource ? { replaySourceRunDir: options.replaySource.runDir } : {}),
        ...engineOptions,
      },
    ),
  };
}

function mutationAdapter(
  manager: CandidateWorkspaceManager,
  mutations: { value: number },
): SemanticEffectAdapter {
  const resolve = async (request: SemanticEffectAdmissionRequest) => {
    const input = request.input as Record<string, unknown>;
    const workspace = input.workspace as CandidateWorkspaceCapability;
    const handle = await manager.describe(workspace);
    return { workspace, handle };
  };
  return {
    kind: "agent",
    semanticInput: async (request) => {
      const { handle } = await resolve(request);
      return {
        task: "replace value",
        workspace: {
          writeScopeHash: handle.ref.writeScopeHash!,
        },
      };
    },
    journalIdentity: async (request) => {
      const { handle } = await resolve(request);
      return {
        semanticKey: stableHash({
          task: "replace value",
          preTreeHash: handle.ref.treeHash,
          lineageHash: handle.ref.lineageHash,
          writeScopeHash: handle.ref.writeScopeHash,
          context: request.run.contextIdentityHash,
        }),
        completionAuthority: "finish-work",
        replayPolicy: "workspace",
      };
    },
    execute: async (request: SemanticEffectRequest) => {
      const { workspace, handle } = await resolve(request);
      await fs.promises.writeFile(path.join(handle.root, "value.txt"), "candidate\n");
      mutations.value++;
      const checkpoint = await manager.prepareCheckpoint({
        operationId: request.operation.operationId,
        workspace,
      });
      return {
        result: { value: "edited", artifacts: [], workspace: checkpoint.record.workspace },
        workspaceCheckpoint: checkpoint.record,
        completionAuthority: "finish-work" as const,
      };
    },
    materializeReplay: async (
      request: SemanticEffectRequest,
      source: SemanticReplaySource,
    ) => {
      const { workspace, handle } = await resolve(request);
      const imported = await manager.importCheckpointForReplay({
        sourceRunDir: source.runDir,
        source: source.workspaceCheckpoint!,
        operationId: request.operation.operationId,
        workspace,
        expectedPreTreeHash: handle.ref.treeHash,
      });
      return {
        result: { ...source.call.result, workspace: imported.record.workspace },
        workspaceCheckpoint: imported.record,
      };
    },
    restore: async (request: SemanticEffectRestoreRequest) => {
      const { workspace } = await resolve(request);
      await manager.restoreForReplay(request.operation.operationId, workspace);
      return request.operation.result.value;
    },
  };
}

function workflowSource(): string {
  return `
export default defineWorkflow({
  name: "phase22-fixture",
  description: "Candidate disposition semantic fixture.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["mode"],
    properties: { mode: { type: "string", enum: ["apply", "reject"] } },
  },
  outputSchema: { type: "object" },
  capabilities: ["read-project", "candidate-write", "human-input"],
  modelVisible: false,
  maxParallelism: 2,
  async run(flow, args) {
    const produced = await flow.candidate("change", async workspace => {
      return await flow.agent("edit", {
        profile: "builtin:implementer",
        prompt: "Replace value.txt.",
        workspace,
      });
    }, { writes: { allow: ["value.txt"] } });
    const verification = await flow.verify("verify", {
      candidate: produced.candidate,
      profile: "builtin:phase22",
    });
    if (args.mode === "reject") {
      const rejected = await flow.reject("reject", {
        candidate: produced.candidate,
        verification,
        reason: "policy rejected candidate",
      });
      return { status: "rejected", reason: rejected.reason, changedPaths: rejected.changedPaths };
    }
    const accepted = await flow.accept("accept", { candidate: produced.candidate, verification });
    const applied = await flow.apply("apply", { candidate: accepted, verification });
    return { status: "applied", changedPaths: applied.changedPaths };
  },
});
`;
}

function verificationProfile(): VerificationProfileDefinition {
  return {
    name: "phase22",
    description: "Deterministic Phase 22 fixture.",
    tests: { notApplicable: "fixture has no command tests" },
    diagnostics: { notApplicable: "fixture has no command diagnostics" },
    diffInspection: {
      requireChanges: true,
      maximumChangedPaths: 8,
      maximumFileBytes: 1024,
      forbidSecrets: true,
      paths: { allow: ["value.txt"] },
    },
    adversarialReview: { notApplicable: "deterministic fixture" },
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(process.cwd(), `.phase22-${prefix}`));
  roots.push(root);
  return root;
}

function zeroUsage() {
  return {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    providerRequests: 0, cost: 0, elapsedMs: 0, complete: true,
  };
}

async function makeWritable(target: string): Promise<void> {
  let stat: fs.Stats;
  try { stat = await fs.promises.lstat(target); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.promises.chmod(target, 0o700).catch(() => undefined);
    for (const name of await fs.promises.readdir(target)) await makeWritable(path.join(target, name));
  } else await fs.promises.chmod(target, 0o600).catch(() => undefined);
}
