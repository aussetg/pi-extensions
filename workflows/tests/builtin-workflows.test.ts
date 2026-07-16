import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SemanticApplyAdapter } from "../src/apply/semantic-adapter.js";
import {
  ArtifactStore,
  createOpaqueArtifactRef,
} from "../src/artifacts/store.js";
import { AgentProtocolClient } from "../src/agents/sdk-protocol.js";
import { SemanticAgentAdapter } from "../src/agents/semantic-adapter.js";
import {
  ScriptedAgentExecutor,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type AgentExecutorDescriptor,
  type AgentRouteSnapshot,
  type AgentToolDescriptor,
} from "../src/agents/executor.js";
import type { PreparedWorkflowExecutionResources } from "../src/agents/resources.js";
import { AgentProfileRegistry, snapshotAgentProfile } from "../src/agents/profiles.js";
import { agentCallProvenance } from "../src/agents/call-identity.js";
import { resolveAgentTools } from "../src/agents/tool-policy.js";
import { SemanticAcceptAdapter, SemanticRejectAdapter } from "../src/candidates/disposition-adapters.js";
import { SemanticCandidateAdapter } from "../src/candidates/semantic-adapter.js";
import { createOpaqueLaunchSnapshotRef } from "../src/candidates/refs.js";
import { CandidateWorkspaceManager } from "../src/candidates/store.js";
import type {
  HostCommandExecutor,
  HostCommandRequest,
  HostCommandResult,
} from "../src/commands/executor.js";
import { resolveCommandInvocation } from "../src/commands/profiles.js";
import { parseStructuredWorkflow } from "../src/definition/workflow-definition.js";
import { SemanticExperimentAdapter } from "../src/experiments/adapter.js";
import { SemanticMeasurementAdapter } from "../src/measurements/adapter.js";
import { StaticMeasurementEnvironmentProvider } from "../src/measurements/environment.js";
import {
  normalizeMeasurementProfile,
  type MeasurementProfileSnapshot,
} from "../src/measurements/profiles.js";
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
} from "../src/runtime/semantic-engine.js";
import type { JsonObject, JsonValue } from "../src/types.js";
import { sha256, stableHash } from "../src/utils/hashes.js";
import { stableJson } from "../src/utils/stable-json.js";
import { SemanticVerificationAdapter } from "../src/verification/semantic-adapter.js";
import type { VerificationCommandEvidence } from "../src/verification/receipts.js";
import {
  VerificationProfileRegistry,
  type VerificationProfileDefinition,
} from "../src/verification/profiles.js";
import { captureProjectSnapshot } from "../src/workspaces/project-snapshot.js";

const roots: string[] = [];
const databases: RunDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) {
    await makeWritable(root);
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

describe("standard built-in workflows through the SQLite semantic coordinator", () => {
  it("executes research through finish_work with progress and artifact handoffs", async () => {
    const fixture = await createFixture("research", {
      question: "How does the fixture work?",
      angles: [{ id: "mechanism", title: "Mechanism" }],
    });
    const outcome = await fixture.execute();
    if (outcome.status === "failed") throw new Error(outcome.error);

    expect(outcome).toMatchObject({
      status: "completed",
      result: { answer: "revised answer", openQuestions: [] },
    });
    expect(fixture.agent.observations.map((entry) => entry.sourceId)).toEqual([
      "research", "draft", "critique", "revision",
    ]);
    expect(fixture.agent.observations.find((entry) => entry.sourceId === "draft")?.inputs).toEqual(["finding-0"]);
    expect(fixture.agent.observations.find((entry) => entry.sourceId === "critique")?.inputs).toEqual([
      "draft", "finding-0",
    ]);
    assertAgentProtocolEvidence(fixture);
  });

  it("executes package-audit with command and agent artifacts rather than prompt copies", async () => {
    const fixture = await createFixture("package-audit", {
      packages: [{ id: "core", path: "value.txt" }],
    });
    const outcome = await fixture.execute();
    if (outcome.status === "failed") throw new Error(outcome.error);

    expect(outcome).toMatchObject({
      status: "completed",
      result: { summary: "portfolio summary", priorities: ["cover the risky path"] },
    });
    expect(fixture.database.listOperations({ limit: 64 }).some((operation) => operation.kind === "command")).toBe(true);
    expect(fixture.agent.observations.find((entry) => entry.sourceId === "inventory")?.inputs).toEqual(["tracked-files"]);
    expect(fixture.agent.observations.find((entry) => entry.sourceId === "risks")?.inputs).toEqual(["inventory"]);
    expect(fixture.agent.observations.find((entry) => entry.sourceId === "test-plan")?.inputs).toEqual([
      "inventory", "risks",
    ]);
    expect(fixture.agent.observations.find((entry) => entry.sourceId === "portfolio")?.inputs).toEqual([
      "package-0-inventory", "package-0-risks", "package-0-tests",
    ]);
    assertAgentProtocolEvidence(fixture);
  });

  it("executes coding through candidate verification and exact human-approved apply", async () => {
    const fixture = await createFixture("coding", { objective: "Change value.txt safely" });
    const waiting = await fixture.execute();
    if (waiting.status === "failed") throw new Error(waiting.error);
    expect(waiting).toMatchObject({ status: "waiting" });
    await approveApply(fixture.database);
    const outcome = await fixture.execute();
    if (outcome.status === "failed") throw new Error(outcome.error);

    expect(outcome).toMatchObject({
      status: "completed",
      result: { status: "applied", changedPaths: ["value.txt"] },
    });
    expect(await fs.promises.readFile(path.join(fixture.project, "value.txt"), "utf8")).toBe("coding-1\n");
    expect(fixture.agent.observations.find((entry) => entry.sourceId === "implement")?.inputs).toEqual([
      "architecture", "risks", "tests",
    ]);
    const implementation = fixture.agent.observations.find((entry) => entry.sourceId === "implement")!;
    expect(implementation.network).toBe("research");
    expect(implementation.tools).toEqual(expect.arrayContaining(["edit", "web_search", "web_fetch"]));
    expect(fixture.database.listOperations({ limit: 64 })
      .filter((operation) => operation.kind === "verify")
      .map((operation) => fixture.database.readVerificationByOperation(operation.operationId)))
      .toEqual([expect.objectContaining({ status: "passed" })]);
    expect(approvalForApply(fixture.database)).toMatchObject({ status: "completed", decision: "approved" });
    assertAgentProtocolEvidence(fixture);
  });

  it("executes a read-only goal directly and uses mediated research without creating a candidate", async () => {
    const fixture = await createFixture("goal", { objective: "Complete this read-only research goal" });
    const outcome = await fixture.execute();
    if (outcome.status === "failed") throw new Error(outcome.error);

    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        status: "completed",
        summary: "read-only goal complete",
        changedPaths: [],
        applied: false,
      },
    });
    expect(fixture.agent.observations).toEqual([
      expect.objectContaining({ sourceId: "read-worker", network: "research", inputs: [] }),
    ]);
    expect(fixture.database.listOperations({ limit: 64 }).some((operation) => operation.kind === "candidate")).toBe(false);
    assertAgentProtocolEvidence(fixture);
  });

  it("turns a read-only handoff into a fresh agent with the selected prior artifact", async () => {
    const fixture = await createFixture("goal", { objective: "Complete this multi-agent read-only goal" });
    const outcome = await fixture.execute();
    if (outcome.status === "failed") throw new Error(outcome.error);
    expect(outcome).toMatchObject({
      status: "completed",
      result: { status: "completed", summary: "second read-only worker complete", applied: false },
    });
    expect(fixture.agent.observations.map((entry) => ({ sourceId: entry.sourceId, inputs: entry.inputs }))).toEqual([
      { sourceId: "read-worker", inputs: [] },
      { sourceId: "read-worker", inputs: ["prior-worker"] },
    ]);
    const sessions = fixture.database.listOperations({ limit: 64 })
      .filter((operation) => operation.kind === "agent")
      .map((operation) => fixture.database.readAgentSessionByOperation(operation.operationId)?.agentSessionId);
    expect(new Set(sessions).size).toBe(2);
  });

  it("hands a goal to fresh workers in one shared candidate and applies only its verified frozen changes", async () => {
    const fixture = await createFixture("goal", { objective: "Implement the candidate goal safely" });
    const waiting = await fixture.execute();
    if (waiting.status === "failed") throw new Error(waiting.error);
    expect(waiting.status).toBe("waiting");
    await approveApply(fixture.database);
    const outcome = await fixture.execute();
    if (outcome.status === "failed") throw new Error(outcome.error);

    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        status: "completed",
        summary: "candidate goal complete",
        changedPaths: ["value.txt"],
        applied: true,
      },
    });
    const workers = fixture.agent.observations.filter((entry) => entry.sourceId.startsWith("write-worker"));
    expect(workers.map((entry) => entry.sourceId)).toEqual(["write-worker-one", "write-worker-two"]);
    expect(workers.map((entry) => entry.workspaceRoot)).toEqual([workers[0]!.workspaceRoot, workers[0]!.workspaceRoot]);
    expect(workers[1]!.inputs).toEqual(["prior-worker"]);
    expect(workers.every((entry) => entry.network === "research")).toBe(true);
    expect(await fs.promises.readFile(path.join(fixture.project, "value.txt"), "utf8")).toBe("goal-2\n");
    expect(approvalForApply(fixture.database)).toMatchObject({ status: "completed", decision: "approved" });
    assertAgentProtocolEvidence(fixture);
  });

  it("turns a blocked goal-worker result into an ordinary durable human checkpoint", async () => {
    const fixture = await createFixture("goal", { objective: "Stop at a blocked goal decision" });
    const outcome = await fixture.execute();
    if (outcome.status === "failed") throw new Error(outcome.error);
    expect(outcome.status).toBe("waiting");
    const operation = fixture.database.listOperations({ limit: 64 })
      .find((entry) => entry.kind === "checkpoint");
    expect(operation).toBeDefined();
    expect(fixture.database.readHumanCheckpoint(operation!.operationId.replace(/^operation_/, "checkpoint_")))
      .toEqual(expect.objectContaining({
        status: "waiting",
        request: expect.objectContaining({ kind: "input", title: "Goal worker is blocked" }),
      }));
  });

  it("launches a fresh correction candidate after failed general verification", async () => {
    const fixture = await createFixture(
      "goal",
      { objective: "Implement a goal that needs one verification correction" },
      { verificationFailures: 1 },
    );
    const waiting = await fixture.execute();
    if (waiting.status === "failed") throw new Error(waiting.error);
    expect(waiting.status).toBe("waiting");
    await approveApply(fixture.database);
    const outcome = await fixture.execute();
    if (outcome.status === "failed") throw new Error(outcome.error);

    expect(outcome).toMatchObject({
      status: "completed",
      result: { status: "completed", applied: true, changedPaths: ["value.txt"] },
    });
    const verifications = fixture.database.listOperations({ limit: 128 })
      .filter((operation) => operation.kind === "verify")
      .map((operation) => fixture.database.readVerificationByOperation(operation.operationId)?.status);
    expect(verifications).toEqual(["failed", "passed"]);
    expect(fixture.database.listOperations({ limit: 128 }).filter((operation) => operation.kind === "candidate"))
      .toHaveLength(2);
    expect(await fs.promises.readFile(path.join(fixture.project, "value.txt"), "utf8")).toBe("goal-4\n");
  });

  it("resumes the same goal operation tree after a coordinator crash without relaunching committed workers", async () => {
    const fixture = await createFixture("goal", { objective: "Implement a crash-resumable candidate goal" });
    let crashed = false;
    await expect(fixture.execute({
      faultInjector: (point, operation) => {
        if (!crashed && point === "after-operation-completion" && operation?.sourceId === "write-worker-one") {
          crashed = true;
          throw new SemanticEngineCrashError("goal coordinator crashed after the first handoff");
        }
      },
    })).rejects.toBeInstanceOf(SemanticEngineCrashError);

    const waiting = await fixture.execute();
    if (waiting.status === "failed") throw new Error(waiting.error);
    expect(waiting.status).toBe("waiting");
    expect(fixture.agent.observations.map((entry) => entry.sourceId)).toEqual([
      "read-worker", "write-worker-one", "write-worker-two",
    ]);
    await approveApply(fixture.database);
    const outcome = await fixture.execute();
    expect(outcome.status).toBe("completed");
  });

  it("replays an explicit completed goal prefix into a new run without launching another worker", async () => {
    const source = await createFixture("goal", { objective: "Complete this read-only research goal" });
    const sourceOutcome = await source.execute();
    expect(sourceOutcome.status).toBe("completed");

    const target = await createFixture(
      "goal",
      { objective: "Complete this read-only research goal" },
      { root: source.root, project: source.project, replaySource: source },
    );
    const targetOutcome = await target.execute();
    if (targetOutcome.status === "failed") throw new Error(targetOutcome.error);
    expect(targetOutcome).toMatchObject({ status: "completed", result: { summary: "read-only goal complete" } });
    expect(target.agent.observations).toEqual([]);
    expect(target.database.readRun().replay).toMatchObject({ matchedCalls: 1 });
  });

  it("executes stable plan points sequentially in one candidate and applies one final freeze", async () => {
    const fixture = await createFixture("execute-plan", {
      objective: "Implement the two-point plan safely",
    });
    const waiting = await fixture.execute();
    if (waiting.status === "failed") throw new Error(waiting.error);
    expect(waiting.status).toBe("waiting");
    await approveApply(fixture.database);
    const outcome = await fixture.execute();
    if (outcome.status === "failed") throw new Error(outcome.error);

    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        status: "completed",
        planRevision: 1,
        ledger: [
          { pointId: "inspect", outcome: "completed" },
          { pointId: "implement", outcome: "completed" },
        ],
        finalChecks: ["run the fixture verification"],
        changedPaths: ["value.txt"],
        applied: true,
      },
    });
    const workers = fixture.agent.observations.filter((entry) => entry.sourceId === "point");
    expect(workers).toHaveLength(2);
    expect(workers[0]!.workspaceRoot).toBe(workers[1]!.workspaceRoot);
    expect(fixture.database.listOperations({ limit: 256 }).filter((entry) => entry.kind === "candidate"))
      .toHaveLength(1);
    expect(fixture.database.listOperations({ limit: 256 }).filter((entry) => entry.kind === "verify"))
      .toHaveLength(1);
    expect(await fs.promises.readFile(path.join(fixture.project, "value.txt"), "utf8"))
      .toBe("execute-plan-2\n");
  });

  it("replans with exact plan, completed-ledger, and workspace-checkpoint artifacts", async () => {
    const fixture = await createFixture("execute-plan", {
      objective: "Implement a plan that explicitly needs replanning",
    });
    const waiting = await fixture.execute();
    if (waiting.status === "failed") throw new Error(waiting.error);
    expect(waiting.status).toBe("waiting");
    const replanner = fixture.agent.observations.find((entry) => entry.sourceId === "replanner");
    expect(replanner?.inputs).toEqual([
      "completed-point-ledger", "current-plan", "workspace-checkpoint",
    ]);
    expect(replanner?.inputKinds["workspace-checkpoint"]).toBe("workspace-checkpoint");
    expect(replanner?.inputKinds["completed-point-ledger"]).toBe("agent-published");
    const candidateAgents = fixture.agent.observations.filter((entry) =>
      entry.sourceId === "point" || entry.sourceId === "replanner");
    expect(new Set(candidateAgents.map((entry) => entry.workspaceRoot)).size).toBe(1);
    await approveApply(fixture.database);
    const outcome = await fixture.execute();
    if (outcome.status === "failed") throw new Error(outcome.error);
    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        status: "completed",
        planRevision: 2,
        ledger: [
          { pointId: "inspect", outcome: "replan" },
          { pointId: "correct", outcome: "completed" },
          { pointId: "finish", outcome: "completed" },
        ],
      },
    });
  });

  it("preserves a structured point failure and rejects the frozen candidate", async () => {
    const fixture = await createFixture("execute-plan", {
      objective: "Encounter a deliberate point failure",
    });
    const outcome = await fixture.execute();
    if (outcome.status === "failed") throw new Error(outcome.error);
    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        status: "failed",
        ledger: [{ pointId: "failing-point", outcome: "failed" }],
        applied: false,
      },
    });
    expect(fixture.database.listOperations({ limit: 128 }).some((entry) => entry.kind === "reject"))
      .toBe(true);
    expect(fixture.database.listOperations({ limit: 128 }).some((entry) => entry.kind === "apply"))
      .toBe(false);
  });

  it("keeps explicitly skipped point evidence in the ordinary result ledger", async () => {
    const fixture = await createFixture("execute-plan", {
      objective: "Implement a plan with an explicitly skipped point",
    });
    const waiting = await fixture.execute();
    if (waiting.status === "failed") throw new Error(waiting.error);
    expect(waiting.status).toBe("waiting");
    await approveApply(fixture.database);
    const outcome = await fixture.execute();
    if (outcome.status === "failed") throw new Error(outcome.error);
    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        ledger: [
          { pointId: "implement", outcome: "completed" },
          { pointId: "obsolete", outcome: "skipped" },
        ],
      },
    });
  });

  it("turns a blocked point into an ordinary durable human checkpoint", async () => {
    const fixture = await createFixture("execute-plan", {
      objective: "Stop at a deliberate blocked plan point",
    });
    const outcome = await fixture.execute();
    if (outcome.status === "failed") throw new Error(outcome.error);
    expect(outcome.status).toBe("waiting");
    const operation = fixture.database.listOperations({ limit: 128 })
      .find((entry) => entry.kind === "checkpoint");
    expect(operation).toBeDefined();
    expect(fixture.database.readHumanCheckpoint(operation!.operationId.replace(/^operation_/, "checkpoint_")))
      .toEqual(expect.objectContaining({
        status: "waiting",
        request: expect.objectContaining({
          kind: "input",
          title: "Execute-plan point is blocked",
        }),
      }));
  });

  it("rejects the single final candidate when final verification fails", async () => {
    const fixture = await createFixture(
      "execute-plan",
      { objective: "Implement a plan whose final verification fails" },
      { verificationFailures: 1 },
    );
    const outcome = await fixture.execute();
    if (outcome.status === "failed") throw new Error(outcome.error);
    expect(outcome).toMatchObject({
      status: "completed",
      result: { status: "verification-failed", applied: false },
    });
    expect(fixture.database.listOperations({ limit: 128 }).filter((entry) => entry.kind === "verify"))
      .toHaveLength(1);
    expect(fixture.database.listOperations({ limit: 128 }).some((entry) => entry.kind === "apply"))
      .toBe(false);
  });

  it("resumes execute-plan after a coordinator crash without relaunching completed points", async () => {
    const fixture = await createFixture("execute-plan", {
      objective: "Implement a crash-resumable two-point plan",
    });
    let crashed = false;
    await expect(fixture.execute({
      faultInjector: (point, operation) => {
        if (!crashed && point === "after-effect-settled" && operation?.sourceId === "point") {
          crashed = true;
          throw new SemanticEngineCrashError("execute-plan coordinator crashed after point settlement");
        }
      },
    })).rejects.toBeInstanceOf(SemanticEngineCrashError);

    const waiting = await fixture.execute();
    if (waiting.status === "failed") throw new Error(waiting.error);
    expect(waiting.status).toBe("waiting");
    expect(fixture.agent.observations.map((entry) => entry.sourceId)).toEqual([
      "planner", "point", "point",
    ]);
    await approveApply(fixture.database);
    expect((await fixture.execute()).status).toBe("completed");
  });

  it("replays the execute-plan prefix and restores its candidate checkpoint in a new run", async () => {
    const source = await createFixture("execute-plan", {
      objective: "Implement a replayable two-point plan",
    });
    const sourceWaiting = await source.execute();
    expect(sourceWaiting.status).toBe("waiting");

    const target = await createFixture(
      "execute-plan",
      { objective: "Implement a replayable two-point plan" },
      { root: source.root, project: source.project, replaySource: source },
    );
    const targetWaiting = await target.execute();
    if (targetWaiting.status === "failed") throw new Error(targetWaiting.error);
    expect(targetWaiting.status).toBe("waiting");
    expect(target.agent.observations).toEqual([]);
    expect(target.database.readRun().replay).toMatchObject({ matchedCalls: 5 });
    const pointOperations = target.database.listOperations({ limit: 256 })
      .filter((entry) => entry.kind === "agent" && entry.sourceId === "point");
    expect(pointOperations.every((entry) => entry.replay?.restoredWorkspaceCheckpointId)).toBe(true);
  });

  it("executes optimize with measured experiments, compact artifact handoffs, and approved apply", async () => {
    const fixture = await createFixture("optimize", {
      objective: "Improve the fixture throughput",
      writePaths: ["value.txt"],
      targetRelativeGain: 0.2,
      maxIterations: 3,
    });
    const waiting = await fixture.execute();
    if (waiting.status === "failed") throw new Error(waiting.error);
    expect(waiting).toMatchObject({ status: "waiting" });
    await approveApply(fixture.database);
    const outcome = await fixture.execute();
    if (outcome.status === "failed") throw new Error(outcome.error);

    expect(outcome).toMatchObject({
      status: "completed",
      result: {
        changed: true,
        experiments: 2,
        metrics: { throughput: { baseline: 10, current: 13 } },
      },
    });
    expect(await fs.promises.readFile(path.join(fixture.project, "value.txt"), "utf8")).toBe("optimize-2\n");
    const hypotheses = fixture.agent.observations.filter((entry) => entry.sourceId === "hypothesis");
    expect(hypotheses).toHaveLength(2);
    expect(hypotheses[0]?.inputs).toEqual([]);
    expect(hypotheses[1]?.inputs).toEqual(["prior-experiment"]);
    expect(hypotheses.every((entry) => entry.network === "research")).toBe(true);
    expect(fixture.agent.observations.filter((entry) => entry.sourceId === "implementation"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ network: "research", inputs: ["experiment-plan"] })]));
    expect(fixture.database.listMeasurements()).toHaveLength(3);
    expect(fixture.database.listExperiments()).toHaveLength(2);
    expect(approvalForApply(fixture.database)).toMatchObject({ status: "completed", decision: "approved" });
    assertAgentProtocolEvidence(fixture);
  });
});

type BuiltinName = "research" | "package-audit" | "coding" | "goal" | "execute-plan" | "optimize";

interface AgentObservation {
  sourceId: string;
  inputs: string[];
  inputKinds: Record<string, string>;
  network: AgentExecutionRequest["network"];
  tools: string[];
  workspaceRoot: string;
}

async function createFixture(
  name: BuiltinName,
  input: JsonObject,
  options: {
    verificationFailures?: number;
    root?: string;
    project?: string;
    replaySource?: { runId: string; runDir: string };
  } = {},
) {
  const source = await fs.promises.readFile(path.join(process.cwd(), "src", "builtins", `${name}.flow.js`), "utf8");
  const parsed = parseStructuredWorkflow(source);
  const root = options.root ?? await fs.promises.mkdtemp(path.join(process.env.HOME ?? process.cwd(), `wf-builtin-${name}-`));
  if (!options.root) roots.push(root);
  const project = options.project ?? path.join(root, "project");
  if (!options.project) {
    await fs.promises.mkdir(project, { recursive: true });
    await fs.promises.writeFile(path.join(project, "value.txt"), "launch\n");
  }
  const runId = `flow_${crypto.randomBytes(16).toString("hex")}`;
  const runDir = path.join(root, runId);
  for (const directory of [
    "context", "sessions", "outputs", "artifacts", "profiles",
    "workspaces/candidates", "workspaces/checkpoints", "workspaces/overlays",
  ]) await fs.promises.mkdir(path.join(runDir, directory), { recursive: true, mode: 0o700 });
  const manifest = await captureProjectSnapshot(project, project, path.join(runDir, "context", "project"));
  await fs.promises.writeFile(path.join(runDir, "context", "project-manifest.json"), `${stableJson(manifest)}\n`);
  const definitionHash = stableHash({ sourceHash: parsed.sourceHash, metadata: parsed.metadata });
  const invocation: SemanticEngineInvocation = {
    workflowId: `builtin:${name}`,
    definitionHash,
    input,
    inputHash: stableHash(input),
  };
  const agent = await scriptedAgent(name, parsed, project, runDir);
  const at = new Date().toISOString();
  const run: RunRecord = {
    runId,
    revision: 1,
    workflow: {
      id: `builtin:${name}`,
      name,
      sourceHash: parsed.sourceHash,
      definitionHash,
      capabilities: parsed.metadata.capabilities,
    },
    invocationHash: semanticInvocationHash(invocation),
    projectSnapshotHash: manifest.treeHash,
    routeSnapshotHash: agent.resources.routeSnapshotHash,
    contextIdentityHash: stableHash({ source: parsed.sourceHash, project: manifest.treeHash }),
    status: "queued",
    safety: {
      concurrency: 4,
      maximumAgentLaunches: 100,
      memoryBytes: 512 * 1024 * 1024,
      tasks: 128,
      cpuQuotaPercent: 200,
      cpuWeight: 100,
      outputBytes: 16 * 1024 * 1024,
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
    createdAt: at,
    updatedAt: at,
  };
  const database = RunDatabase.create(path.join(runDir, "run.sqlite"), { run });
  databases.push(database);
  const manager = await CandidateWorkspaceManager.open(runDir, database);
  const adapterFactories: Array<() => SemanticEffectAdapter> = [
    () => new SemanticAgentAdapter({
      runDir,
      database,
      resources: agent.resources,
      executor: agent.executor,
      candidateManager: manager,
    }),
  ];
  if (name === "package-audit") adapterFactories.push(() => new InventoryCommandAdapter(runDir, database));
  if (name === "coding" || name === "goal" || name === "execute-plan" || name === "optimize") {
    const verifications = new VerificationProfileRegistry();
    const checks = { count: 0 };
    await verifications.refresh(project, {
      builtins: [verificationProfile(name === "goal" || name === "execute-plan")],
      userDir: path.join(runDir, "missing-verifications"),
    });
    adapterFactories.push(
      () => new SemanticCandidateAdapter({ manager }),
      () => new SemanticVerificationAdapter({
        runDir,
        database,
        profiles: verifications.list(),
        evidence: {
          environmentIdentity: () => ({ fixture: "builtin-verification-v1" }),
          collect: async () => {
            if (name !== "goal" && name !== "execute-plan") return {};
            checks.count += 1;
            return { tests: [verificationCommandEvidence(checks.count <= (options.verificationFailures ?? 0))] };
          },
        },
      }),
      () => new SemanticAcceptAdapter({ runDir, database }),
      () => new SemanticRejectAdapter({ runDir, database }),
    );
  }
  if (name === "optimize") {
    const measurement = measurementProfile();
    const outputs = [10, 11, 13].flatMap((throughput, cohort) => (
      Array.from({ length: 4 }, (_, sample) => measurementProtocol(throughput, 50, cohort * 4 + sample))
    ));
    const measurementExecutor = new ScriptedMeasurementExecutor(outputs);
    adapterFactories.push(
      () => new SemanticMeasurementAdapter({
        runDir,
        database,
        profiles: [measurement],
        environment: new StaticMeasurementEnvironmentProvider({ fixture: "builtin-measurement-v1" }),
        executor: measurementExecutor,
        launchWorkspace: {
          root: path.join(runDir, "context", "project"),
          cwd: path.join(runDir, "context", "project"),
          workspace: {
            kind: "snapshot",
            workspaceId: `snapshot_${"1".repeat(32)}`,
            treeHash: manifest.treeHash,
          },
        },
        pressure: { capture: async () => ({ cpu: { some: { avg10: 0 } } }) },
      }),
      () => new SemanticExperimentAdapter({ runDir, database }),
    );
  }
  if (name === "coding" || name === "goal" || name === "execute-plan" || name === "optimize") {
    adapterFactories.push(() => new SemanticApplyAdapter({
      runDir,
      database,
      currentVerificationBinding: (verification) => ({
        profileHash: verification.profileHash,
        gateEnvironmentHash: verification.gateEnvironmentHash,
      }),
    }));
  }
  const snapshot = createOpaqueLaunchSnapshotRef({ runId, snapshotHash: manifest.treeHash });
  return {
    name,
    root,
    project,
    runId,
    runDir,
    database,
    agent,
    execute: (
      engineOptions: Parameters<typeof executeSequentialSemanticRun>[5] = {},
    ) => executeSequentialSemanticRun(runDir, database, parsed, invocation, adapterFactories.map((factory) => factory()), {
      snapshot,
      controlPollIntervalMs: 5,
      ...(options.replaySource ? { replaySourceRunDir: options.replaySource.runDir } : {}),
      ...engineOptions,
    }),
  };
}

async function scriptedAgent(
  workflow: BuiltinName,
  parsed: ReturnType<typeof parseStructuredWorkflow>,
  project: string,
  runDir: string,
) {
  const observations: AgentObservation[] = [];
  let candidateMutations = 0;
  const sourceCalls = new Map<string, number>();
  const descriptor = executorDescriptor();
  const executor = new ScriptedAgentExecutor({
    descriptor,
    run: async (request) => {
      const sourceId = request.operationPath.slice(request.operationPath.lastIndexOf("agent:") + "agent:".length);
      const sourceCall = (sourceCalls.get(sourceId) ?? 0) + 1;
      sourceCalls.set(sourceId, sourceCall);
      observations.push({
        sourceId,
        inputs: request.inputs.entries.map((entry) => entry.id).sort(),
        inputKinds: Object.fromEntries(
          request.inputs.entries.map((entry) => [entry.id, entry.artifact.kind]),
        ),
        network: request.network,
        tools: request.tools.map((tool) => tool.name).sort(),
        workspaceRoot: request.workspace.root,
      });
      if (!request.outputSchema) throw new Error(`Built-in agent ${request.operationPath} has no exact finish_work schema`);
      if (request.workspace.mode === "candidate") {
        candidateMutations += 1;
        await fs.promises.writeFile(path.join(request.workspace.root, "value.txt"), `${workflow}-${candidateMutations}\n`);
      }
      return await committedFinish(request, agentPayload(workflow, sourceId, candidateMutations, sourceCall, request));
    },
  });
  const profiles = new AgentProfileRegistry();
  await profiles.refresh(project, { userDir: path.join(runDir, "missing-agent-profiles") });
  const profileSelectors: Record<string, string> = {};
  const profileSnapshots = [...new Set(parsed.agentSelections.map((selection) => selection.profile))]
    .map((selector) => {
      const profile = profiles.resolve(selector);
      profileSelectors[selector] = profile.id;
      return snapshotAgentProfile(profile);
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const routes: AgentRouteSnapshot[] = profileSnapshots.map((profile) => {
    const body = { profileId: profile.id, provider: "test", model: "test/model", thinking: "off" as const };
    const hash = stableHash(body);
    return { id: `route_${hash.slice(7, 39)}`, ...body, hash };
  });
  const profileById = new Map(profileSnapshots.map((profile) => [profile.id, profile]));
  const routeByProfile = new Map(routes.map((route) => [route.profileId, route]));
  const selections = parsed.agentSelections.map((selection) => {
    const profileId = profileSelectors[selection.profile]!;
    const profile = profileById.get(profileId)!;
    const route = routeByProfile.get(profileId)!;
    const tools = resolveAgentTools(profile, {
      workspace: selection.workspace,
      network: selection.network,
    }, descriptor);
    return {
      operationId: selection.id,
      profileId,
      profileHash: profile.hash,
      routeId: route.id,
      routeHash: route.hash,
      workspace: selection.workspace,
      network: selection.network,
      resultMode: selection.resultMode,
      tools,
      authorityHash: stableHash({
        ...agentCallProvenance(profile, route, tools),
        workspace: selection.workspace,
        network: selection.network,
        resultMode: selection.resultMode,
      }),
    };
  });
  const contextBundle = { entries: [], hash: stableHash([]) };
  const body = {
    formatVersion: 1 as const,
    definitionSourceHash: parsed.sourceHash,
    projectRoot: project,
    projectCwd: project,
    profiles: profileSnapshots,
    profileSelectors,
    routes,
    routeSnapshotHash: stableHash(routes),
    agentSelections: selections,
    contextBundle,
    executor: descriptor,
    commands: [],
    measurements: [],
    verifications: [],
    candidateCapable: parsed.metadata.capabilities.includes("candidate-write"),
  };
  const resources: PreparedWorkflowExecutionResources = { ...body, hash: stableHash(body) };
  return { executor, resources, observations };
}

function agentPayload(
  workflow: BuiltinName,
  sourceId: string,
  attempt: number,
  sourceCall: number,
  request: AgentExecutionRequest,
): JsonValue {
  if (workflow === "research") {
    if (sourceId === "research") return { summary: "mechanism finding", evidence: [{ claim: "observed", source: "https://example.test/source" }] };
    if (sourceId === "critique") return { passed: false, problems: ["tighten the answer"] };
    if (sourceId === "draft") return report("draft answer");
    if (sourceId === "revision") return report("revised answer");
  }
  if (workflow === "package-audit") {
    if (sourceId === "inventory") return { packageId: "core", summary: "inventory", files: ["value.txt"], observations: ["small package"] };
    if (sourceId === "risks") return { packageId: "core", summary: "risk summary", risks: ["unchecked edge"] };
    if (sourceId === "test-plan") return { packageId: "core", summary: "test plan", tests: ["cover the risky path"] };
    if (sourceId === "portfolio") return { summary: "portfolio summary", priorities: ["cover the risky path"] };
  }
  if (workflow === "coding") {
    if (["architecture", "tests", "risks"].includes(sourceId)) {
      return { summary: `${sourceId} summary`, findings: [`${sourceId} finding`] };
    }
    if (sourceId === "implement") return { summary: "implemented", changedPaths: ["value.txt"], checks: ["fixture check"] };
  }
  if (workflow === "goal") {
    const output = (id: string, kind: "finding" | "change", summary: string) => ({ id, kind, summary });
    if (sourceId === "read-worker") {
      if (request.instruction.kind === "initial-task" && request.instruction.task.includes("blocked goal decision")) {
        return {
          outcome: "blocked",
          summary: "a human decision is required",
          outputs: [output("decision-boundary", "finding", "reached the exact decision boundary")],
          nextWork: ["choose the safe direction"],
          workspace: "read-only",
          blocker: "Choose the safe direction",
        };
      }
      if (request.instruction.kind === "initial-task" && request.instruction.task.includes("read-only research goal")) {
        return {
          outcome: "completed",
          summary: "read-only goal complete",
          outputs: [output("research", "finding", "source-grounded answer")],
          nextWork: [],
          workspace: "read-only",
          blocker: null,
        };
      }
      if (request.instruction.kind === "initial-task" && request.instruction.task.includes("multi-agent read-only goal")) {
        return sourceCall === 1 ? {
          outcome: "handoff",
          summary: "first read-only worker complete",
          outputs: [output("first-research", "finding", "first selected evidence")],
          nextWork: ["synthesize the selected evidence"],
          workspace: "read-only",
          blocker: null,
        } : {
          outcome: "completed",
          summary: "second read-only worker complete",
          outputs: [output("synthesis", "finding", "synthesized selected evidence")],
          nextWork: [],
          workspace: "read-only",
          blocker: null,
        };
      }
      return {
        outcome: "handoff",
        summary: "candidate work is required",
        outputs: [output("inspection", "finding", "identified the required mutation")],
        nextWork: ["implement and verify value.txt"],
        workspace: "candidate",
        blocker: null,
      };
    }
    if (sourceId === "write-worker-one") {
      return {
        outcome: "handoff",
        summary: "first candidate slice complete",
        outputs: [output("first-change", "change", "prepared the first candidate slice")],
        nextWork: ["finish checks in the same candidate"],
        workspace: "candidate",
        blocker: null,
      };
    }
    if (sourceId === "write-worker-two") {
      return {
        outcome: "completed",
        summary: "candidate goal complete",
        outputs: [output("final-change", "change", `completed candidate mutation ${attempt}`)],
        nextWork: [],
        workspace: "candidate",
        blocker: null,
      };
    }
    throw new Error(`Unexpected goal worker ${sourceId} call ${sourceCall}`);
  }
  if (workflow === "execute-plan") {
    const task = request.instruction.kind === "initial-task" ? request.instruction.task : "";
    const plan = (points: Array<{ id: string; objective: string }>) => ({
      summary: `plan with ${points.length} point(s)`,
      points: points.map((point) => ({ ...point, checks: [`check ${point.id}`] })),
      finalChecks: ["run the fixture verification"],
    });
    if (sourceId === "planner") {
      if (task.includes("point failure")) {
        return plan([{ id: "failing-point", objective: "exercise the structured failure path" }]);
      }
      if (task.includes("blocked plan point")) {
        return plan([{ id: "blocked-point", objective: "request the exact human decision" }]);
      }
      if (task.includes("needs replanning")) {
        return plan([{ id: "inspect", objective: "discover why the initial plan is invalid" }]);
      }
      if (task.includes("explicitly skipped point")) {
        return plan([
          { id: "implement", objective: "implement the required change" },
          { id: "obsolete", objective: "skip this point with explicit evidence" },
        ]);
      }
      return plan([
        { id: "inspect", objective: "inspect the required change" },
        { id: "implement", objective: "implement and check the required change" },
      ]);
    }
    if (sourceId === "replanner") {
      return plan([
        { id: "correct", objective: "apply the corrected implementation" },
        { id: "finish", objective: "finish the corrected checks" },
      ]);
    }
    if (sourceId === "point") {
      const pointId = /Stable point ID: ([a-z][a-z0-9_-]*)/.exec(task)?.[1];
      if (!pointId) throw new Error("Execute-plan point prompt has no stable point ID");
      const outcome = pointId === "failing-point" ? "failed"
        : pointId === "blocked-point" ? "blocked"
        : pointId === "obsolete" ? "skipped"
        : pointId === "inspect" && task.includes("needs replanning") ? "replan"
        : "completed";
      return {
        outcome,
        pointId,
        summary: `${pointId} ${outcome}`,
        evidence: [{ id: `${pointId}-evidence`, summary: `durable evidence for ${pointId}` }],
        nextWork: outcome === "replan" ? ["replace the remaining plan"] : [],
        blocker: outcome === "blocked" ? "Choose whether to verify the completed candidate" : null,
      };
    }
    throw new Error(`Unexpected execute-plan worker ${sourceId} call ${sourceCall}`);
  }
  if (workflow === "optimize") {
    if (sourceId === "hypothesis" || sourceId === "implementation") {
      return {
        hypothesis: `attempt ${Math.max(1, attempt)}`,
        changeSummary: "changed value.txt",
        expectedEffect: "higher throughput",
        nextFocus: "next distinct branch",
      };
    }
    if (sourceId === "reflection") return { learned: "the attempt improved throughput", nextFocus: "the next distinct branch" };
  }
  throw new Error(`No scripted result for ${workflow} ${sourceId}`);
}

function report(answer: string): JsonValue {
  return {
    answer,
    claims: [{ claim: "observed", sources: ["https://example.test/source"] }],
    openQuestions: [],
  };
}

async function committedFinish(request: AgentExecutionRequest, payload: JsonValue): Promise<AgentExecutionResult> {
  const client = await AgentProtocolClient.connect({
    socketPath: request.protocol.socketPath,
    executionId: request.executionId,
    executionToken: request.protocol.executionToken,
  });
  try {
    await client.emit(agentEvent(request, 1, { type: "execution-start" }));
    await client.emit(agentEvent(request, 2, { type: "assistant-text", text: "This prose is not the result." }));
    await client.request("report_progress", "tool-progress", { message: `working on ${request.operationPath}`, current: 1, total: 1 });
    await client.request("log_result", "tool-log", { message: `durable finding for ${request.operationPath}` });
    if (request.resultMode === "artifact" || request.resultMode === "value-and-artifact") {
      const output = path.join(path.dirname(request.protocol.socketPath), "outputs", request.executionId);
      await fs.promises.mkdir(output, { recursive: true });
      await fs.promises.writeFile(path.join(output, "handoff.json"), `${JSON.stringify(payload)}\n`);
      await client.request("publish_artifact", "tool-artifact", {
        path: "handoff.json",
        name: "handoff",
        format: "json",
      });
    }
    const response = await client.request("finish_work", "tool-finish", payload);
    return {
      outcome: "finished",
      finish: (response as unknown as { finish: AgentExecutionResult & { finish: never } }).finish as never,
      usage: { ...zeroUsage(), inputTokens: 5, outputTokens: 3, providerRequests: 1, elapsedMs: 10 },
      transcriptComplete: true,
    };
  } finally {
    await client.close();
  }
}

class InventoryCommandAdapter implements SemanticEffectAdapter {
  readonly kind = "command" as const;
  private readonly store: ArtifactStore;

  constructor(runDir: string, database: RunDatabase) {
    this.store = new ArtifactStore(runDir, database);
  }

  semanticInput(request: SemanticEffectAdmissionRequest): JsonValue {
    const input = request.input as Record<string, JsonValue>;
    return { profile: input.profile!, args: input.args ?? {} };
  }

  journalIdentity(request: SemanticEffectAdmissionRequest) {
    return {
      semanticKey: stableHash({ path: request.path, input: this.semanticInput(request) }),
      completionAuthority: "host-effect" as const,
      replayPolicy: "immutable" as const,
    };
  }

  async execute(request: SemanticEffectRequest) {
    const output = await this.store.putText({
      expectedRevision: request.database.readRun().revision,
      kind: "command-output",
      text: "value.txt\n",
      metadata: { profile: "builtin:tracked-files" },
    });
    return {
      result: {
        value: { ok: true, exitCode: 0, durationMs: 1, stdout: "value.txt\n" },
        artifacts: [output.artifact],
      },
      completionAuthority: "host-effect" as const,
    };
  }

  restore(request: SemanticEffectRestoreRequest) {
    const artifact = request.operation.result.artifacts[0];
    if (!artifact) throw new Error("Tracked-file command has no output artifact");
    return {
      ...(request.operation.result.value as Record<string, JsonValue>),
      outputArtifact: createOpaqueArtifactRef(artifact),
    };
  }
}

class ScriptedMeasurementExecutor implements HostCommandExecutor {
  private call = 0;
  constructor(private readonly outputs: string[]) {}
  describe() { return { id: "builtin-measurement-test", protocolVersion: 1 as const, sandbox: "fake" as const }; }
  async execute(request: HostCommandRequest): Promise<HostCommandResult> {
    const output = this.outputs[this.call++];
    if (output === undefined) throw new Error(`No output for measurement call ${this.call}`);
    const stdout = Buffer.from(output);
    const stderr = Buffer.alloc(0);
    const invocation = resolveCommandInvocation(request.profile, request.arguments, request.effect);
    return {
      status: "completed",
      exitCode: 0,
      timedOut: false,
      stdout,
      stderr,
      stdoutEvidence: { bytes: stdout.length, digest: sha256(stdout), inlineBytes: stdout.length, truncated: false },
      stderrEvidence: { bytes: 0, digest: sha256(stderr), inlineBytes: 0, truncated: false },
      exitEvidence: { kind: "exit", code: 0 },
      invocation,
      executor: this.describe(),
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:00.001Z",
      unit: `pi-workflow-measurement-${"a".repeat(32)}.service`,
      unitCleaned: true,
    };
  }
}

function measurementProfile(): MeasurementProfileSnapshot {
  const definition = normalizeMeasurementProfile({
    name: "runtime-baseline",
    description: "Deterministic built-in workflow fixture.",
    argv: ["/usr/bin/printf", "fixture"],
    timeoutMs: 10_000,
    outputs: {
      "peak-rss": { extract: { kind: "protocol" } },
      throughput: { extract: { kind: "protocol" } },
    },
    diagnostics: {
      extract: { kind: "protocol" },
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["marker"],
        properties: { marker: { type: "integer", minimum: 0 } },
      },
    },
  });
  return {
    ...definition,
    id: "builtin:runtime-baseline",
    namespace: "builtin",
    path: "<builtin:runtime-baseline>",
    hash: stableHash({ namespace: "builtin", definition }),
  };
}

function measurementProtocol(throughput: number, peakRss: number, marker: number): string {
  return [
    JSON.stringify({ type: "metric", id: "peak-rss", value: peakRss }),
    JSON.stringify({ type: "metric", id: "throughput", value: throughput }),
    JSON.stringify({ type: "diagnostic", data: { marker } }),
    "",
  ].join("\n");
}

function verificationProfile(withGoalCheck = false): VerificationProfileDefinition {
  return {
    name: "coding",
    description: "Deterministic verification for built-in workflow tests.",
    tests: withGoalCheck
      ? [{ id: "goal-check", argv: ["/usr/bin/true"], timeoutMs: 10_000 }]
      : { notApplicable: "fixture" },
    diagnostics: { notApplicable: "fixture" },
    diffInspection: {
      requireChanges: true,
      maximumChangedPaths: 8,
      maximumFileBytes: 1024,
      forbidSecrets: true,
      paths: { allow: ["value.txt"] },
    },
    adversarialReview: { notApplicable: "fixture" },
  };
}

function verificationCommandEvidence(failed: boolean): VerificationCommandEvidence {
  return {
    commandId: "goal-check",
    status: "completed",
    exitCode: failed ? 1 : 0,
    timedOut: false,
    stdoutDigest: sha256(""),
    stdoutBytes: 0,
    stderrDigest: sha256(""),
    stderrBytes: 0,
    environmentHash: sha256("goal-check-v1"),
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.001Z",
  };
}

async function approveApply(database: RunDatabase): Promise<void> {
  const operation = database.listOperations({ limit: 256 }).find((entry) => entry.kind === "apply");
  if (!operation) throw new Error("Workflow did not reach apply");
  const plan = database.readApplyPlanByOperation(operation.operationId);
  const approval = plan ? database.readApproval(plan.approvalId) : undefined;
  if (!approval || approval.status !== "waiting") throw new Error("Apply approval is not waiting");
  database.enqueueControlRequest({
    requestId: `request_${crypto.randomBytes(16).toString("hex")}`,
    runId: database.readRun().runId,
    expectedRevision: database.readRun().revision,
    requestedAt: new Date().toISOString(),
    actor: "human:test",
    kind: "approve",
    approvalId: approval.approvalId,
    challengeHash: approval.challenge.challengeHash,
  });
  const request = database.listPendingControlRequests(1)[0]!;
  const resolved = database.resolveApprovalControlRequest(
    database.readRun().revision,
    request.requestId,
    new Date().toISOString(),
  );
  if (!resolved.acknowledgement.accepted) throw new Error("Exact apply approval was rejected");
}

function approvalForApply(database: RunDatabase) {
  const operation = database.listOperations({ limit: 256 }).find((entry) => entry.kind === "apply");
  const plan = operation ? database.readApplyPlanByOperation(operation.operationId) : undefined;
  return plan ? database.readApproval(plan.approvalId) : undefined;
}

function assertAgentProtocolEvidence(fixture: Awaited<ReturnType<typeof createFixture>>): void {
  const operations = fixture.database.listOperations({ limit: 256 }).filter((operation) => operation.kind === "agent");
  expect(operations).toHaveLength(fixture.agent.observations.length);
  for (const operation of operations) {
    const session = fixture.database.readAgentSessionByOperation(operation.operationId)!;
    expect(session).toMatchObject({
      status: "completed",
      finish: { toolCallId: "tool-finish" },
    });
    expect(fixture.database.listAgentProgress(session.agentSessionId, { limit: 16 }).map((entry) => entry.event))
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: "log" })]));
  }
}

function executorDescriptor(): AgentExecutorDescriptor {
  const authority: Record<string, { mutatesWorkspace: boolean; usesMediatedNetwork: boolean }> = {
    read: { mutatesWorkspace: false, usesMediatedNetwork: false },
    grep: { mutatesWorkspace: false, usesMediatedNetwork: false },
    find: { mutatesWorkspace: false, usesMediatedNetwork: false },
    ls: { mutatesWorkspace: false, usesMediatedNetwork: false },
    edit: { mutatesWorkspace: true, usesMediatedNetwork: false },
    write: { mutatesWorkspace: true, usesMediatedNetwork: false },
    delete_file: { mutatesWorkspace: true, usesMediatedNetwork: false },
    workspace_command: { mutatesWorkspace: true, usesMediatedNetwork: false },
    web_search: { mutatesWorkspace: false, usesMediatedNetwork: true },
    web_fetch: { mutatesWorkspace: false, usesMediatedNetwork: true },
  };
  const toolCatalog: AgentToolDescriptor[] = Object.entries(authority).map(([name, flags], index) => ({
    name,
    schemaHash: index.toString(16).padStart(64, "0"),
    ...flags,
  }));
  return {
    id: "builtin-workflow-test",
    protocolVersion: 1,
    capabilities: {
      persistentSessions: true,
      candidateWorkspace: true,
      mediatedNetwork: true,
      liveProgress: true,
      artifactPublication: true,
    },
    toolCatalog,
  };
}

function agentEvent(request: AgentExecutionRequest, sequence: number, body: Record<string, unknown>) {
  return {
    ...body,
    executionId: request.executionId,
    operationId: request.operationId,
    attemptId: request.attemptId,
    sequence,
    at: new Date().toISOString(),
  } as any;
}

function zeroUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerRequests: 0,
    cost: 0,
    elapsedMs: 0,
    complete: true,
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
