import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SdkAgentWorkerExecutor } from "../src/agents/sdk-executor.js";
import { SandboxedCommandExecutor } from "../src/commands/executor.js";
import { HostMeasurementEnvironmentProvider } from "../src/measurements/environment.js";
import { createWorkflowInvocationSnapshot, writeWorkflowInvocationSnapshot } from "../src/persistence/workflow-invocation.js";
import { WorkflowRunDatabase } from "../src/persistence/run-database.js";
import { WorkflowRunCatalog } from "../src/persistence/run-catalog.js";
import { WorkflowRegistry } from "../src/registry/structured-workflows.js";
import { prepareWorkflowResources } from "../src/runtime/prepare-resources.js";
import { WorkflowCoordinatorService } from "../src/runtime/coordinator-service.js";
import { coordinatorUnitName } from "../src/runtime/coordinator-identity.js";
import { WorkflowNamedService } from "../src/runtime/named-workflow-service.js";
import { WorkflowRunCoordinator } from "../src/runtime/run-coordinator.js";
import { captureProjectSnapshot } from "../src/workspaces/project-snapshot.js";
import { stableHash } from "../src/utils/hashes.js";
import { stableJson } from "../src/utils/stable-json.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.promises.rm(root, { recursive: true, force: true }))); });

describe("production workflow coordinator", () => {
  it("executes its exact snapshotted TypeScript and persists the workflow result", async () => {
    const fixture = await createPreparedRun(`
      import { workflow, schema as s } from "pi/workflows";
      export default workflow({
        description: "Pure production fixture",
        input: s.object({ value: s.string() }),
        output: s.object({ value: s.string() }),
        async run(_flow, args) {
          const suffix: string = "!";
          return { value: args.value + suffix };
        },
      });
    `, { value: "ready" });

    const outcome = await new WorkflowRunCoordinator(fixture.runDir, { processIdentityCheck: false }).run();
    expect(outcome.status).toBe("completed");
    const database = WorkflowRunDatabase.open(fixture.databasePath);
    try {
      expect(database.readRun()).toMatchObject({ status: "completed", result: { value: "ready!" } });
      database.validateIntegrity();
    } finally { database.close(); }
  });

  it("launches the real coordinator service with exact systemd process identity", async () => {
    const fixture = await createPreparedRun(`
      import { workflow, schema as s } from "pi/workflows";
      export default workflow({
        description: "Systemd coordinator fixture",
        input: s.object({ value: s.string() }),
        output: s.object({ value: s.string() }),
        async run(_flow, args) { return { value: args.value }; },
      });
    `, { value: "systemd" });
    const service = new WorkflowCoordinatorService();
    let launched: Awaited<ReturnType<WorkflowCoordinatorService["launch"]>> | undefined;
    try {
      launched = await service.launch(fixture.runDir);
      expect(launched.unit).toBe(coordinatorUnitName(fixture.runId));
      const completion = await launched.handle.wait();
      expect(completion.outcome).toBe("success");
      const database = WorkflowRunDatabase.open(fixture.databasePath);
      try {
        expect(database.readRun()).toMatchObject({
          status: "completed",
          result: { value: "systemd" },
        });
      } finally { database.close(); }
    } finally {
      await launched?.handle.collect().catch(() => undefined);
    }
  }, 30_000);

  it("settles unrecoverable prepared-context failure instead of relaunching forever", async () => {
    const fixture = await createPreparedRun(`
      import { workflow, schema as s } from "pi/workflows";
      export default workflow({
        description: "Broken context fixture",
        input: s.object({ value: s.string() }),
        output: s.object({ value: s.string() }),
        async run(_flow, args) { return { value: args.value }; },
      });
    `, { value: "never" });
    await fs.promises.rm(path.join(fixture.runDir, "context", "static-resources.json"));
    const outcome = await new WorkflowRunCoordinator(fixture.runDir, { processIdentityCheck: false }).run();
    expect(outcome.status).toBe("failed");
    const database = WorkflowRunDatabase.open(fixture.databasePath);
    try { expect(database.readRun().reason).toMatchObject({ code: "coordinator-setup-failed", retryable: false }); }
    finally { database.close(); }
  });

  it("fails before control when the immutable launch snapshot tree was tampered", async () => {
    const fixture = await createPreparedRun(`
      import { workflow, schema as s } from "pi/workflows";
      export default workflow({
        description: "Tampered project fixture",
        input: s.object({ value: s.string() }),
        output: s.object({ value: s.string() }),
        async run(_flow, args) { return { value: args.value }; },
      });
    `, { value: "never" });
    await fs.promises.writeFile(path.join(fixture.runDir, "context", "project", "README.md"), "tampered\n");
    const outcome = await new WorkflowRunCoordinator(fixture.runDir, { processIdentityCheck: false }).run();
    expect(outcome.status).toBe("failed");
    const database = WorkflowRunDatabase.open(fixture.databasePath);
    try {
      expect(database.readRun().reason).toMatchObject({
        code: "coordinator-setup-failed",
        summary: "Prepared workflow project snapshot tree is corrupt",
      });
      expect(database.listOperations()).toHaveLength(0);
    } finally { database.close(); }
  });

  it("suspends at ask, commits an exact response, and reconstructs ordinary local state", async () => {
    const fixture = await createPreparedRun(`
      import { workflow, schema as s } from "pi/workflows";
      export default workflow({
        description: "Human production fixture",
        input: s.object({ prefix: s.string() }),
        output: s.object({ answer: s.string() }),
        async run(flow, args) {
          const before = args.prefix + ":";
          const answer = await flow.ask({ prompt: "Continue?", response: s.string() });
          return { answer: before + answer };
        },
      });
    `, { prefix: "kept" });

    const first = await new WorkflowRunCoordinator(fixture.runDir, { processIdentityCheck: false }).run();
    expect(first.status).toBe("waiting");
    const database = WorkflowRunDatabase.open(fixture.databasePath);
    try {
      const interaction = database.listWaitingHumanInteractions()[0]!;
      database.enqueueControlRequest({
        requestId: "request_invalid_00000000000000001",
        runId: database.readRun().runId,
        kind: "ask-response",
        targetId: interaction.interactionId,
        challengeHash: interaction.challengeHash,
        value: 7,
        actor: "human:test",
        status: "pending",
        requestedAt: new Date().toISOString(),
      });
    } finally { database.close(); }

    const rejected = await new WorkflowRunCoordinator(fixture.runDir, { processIdentityCheck: false }).run();
    expect(rejected.status).toBe("waiting");
    const waiting = WorkflowRunDatabase.open(fixture.databasePath);
    try {
      expect(waiting.readControlRequest("request_invalid_00000000000000001")?.status).toBe("rejected");
      const interaction = waiting.listWaitingHumanInteractions()[0]!;
      waiting.enqueueControlRequest({
        requestId: "request_response_0000000000000001",
        runId: waiting.readRun().runId,
        kind: "ask-response",
        targetId: interaction.interactionId,
        challengeHash: interaction.challengeHash,
        value: "yes",
        actor: "human:test",
        status: "pending",
        requestedAt: new Date().toISOString(),
      });
    } finally { waiting.close(); }
    const second = await new WorkflowRunCoordinator(fixture.runDir, { processIdentityCheck: false }).run();
    expect(second.status).toBe("paused");
    const paused = WorkflowRunDatabase.open(fixture.databasePath);
    try {
      paused.enqueueControlRequest({
        requestId: "request_resume_00000000000000001",
        runId: paused.readRun().runId,
        kind: "resume",
        actor: "human:test",
        status: "pending",
        requestedAt: new Date().toISOString(),
      });
    } finally { paused.close(); }
    const third = await new WorkflowRunCoordinator(fixture.runDir, { processIdentityCheck: false }).run();
    expect(third.status).toBe("completed");
    const settled = WorkflowRunDatabase.open(fixture.databasePath);
    try { expect(settled.readRun().result).toEqual({ answer: "kept:yes" }); }
    finally { settled.close(); }
  });

  it("rejects cross-project replay and host-incompatible replay modes before launch", async () => {
    const fixture = await createPreparedRun(`
      import { workflow, schema as s } from "pi/workflows";
      export default workflow({
        description: "Replay project fixture",
        input: s.object({ value: s.string() }),
        output: s.object({ value: s.string() }),
        async run(_flow, args) { return { value: args.value }; },
      });
    `, { value: "source" });
    const otherProject = await fs.promises.mkdtemp(path.join(os.homedir(), ".wf-other-project-"));
    roots.push(otherProject);
    const service = new WorkflowNamedService(fakePi() as never, {
      catalog: new WorkflowRunCatalog(fixture.root),
      coordinator: { launcher: {}, launch: vi.fn() } as never,
    });
    const invalidMode = extensionContext("owner", fixture.project, "json");
    await expect(service.replay({
      sourceRunRef: fixture.runId,
      mode: "async",
      fresh: false,
    }, "user", invalidMode as never)).rejects.toThrow("Async workflows are unavailable in json mode");

    const wrongProject = extensionContext("owner", otherProject, "tui");
    await expect(service.replay({
      sourceRunRef: fixture.runId,
      mode: "await",
      fresh: false,
    }, "user", wrongProject as never)).rejects.toThrow("Replay source belongs to another project");
  });

  it("restores async notifications only for the exact launch session and project, once", async () => {
    const fixture = await createPreparedRun(`
      import { workflow, schema as s } from "pi/workflows";
      export default workflow({
        description: "Async notification fixture",
        input: s.object({ value: s.string() }),
        output: s.object({ value: s.string() }),
        async run(_flow, args) { return { value: args.value }; },
      });
    `, { value: "done" }, {
      launch: { mode: "async", sessionId: "owner", projectRoot: "project" },
    });
    await new WorkflowRunCoordinator(fixture.runDir, { processIdentityCheck: false }).run();
    const pi = fakePi();
    const service = new WorkflowNamedService(pi as never, {
      catalog: new WorkflowRunCatalog(fixture.root),
      coordinator: { launcher: {}, launch: vi.fn() } as never,
    });
    const wrongOwner = extensionContext("other", fixture.project, "tui");
    await service.restoreAsyncNotifications(wrongOwner as never);
    expect(pi.sendMessage).not.toHaveBeenCalled();

    const owner = extensionContext("owner", fixture.project, "tui");
    await service.restoreAsyncNotifications(owner as never);
    await service.restoreAsyncNotifications(owner as never);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(owner.ui.notify).toHaveBeenCalledTimes(1);
  });
});

async function createPreparedRun(
  source: string,
  input: Record<string, string>,
  options: { launch?: { mode: "await" | "async"; sessionId: string; projectRoot: "project" } } = {},
) {
  const root = await fs.promises.mkdtemp(path.join(os.homedir(), ".wf-"));
  roots.push(root);
  const registryRoot = path.join(root, "registry");
  const project = path.join(root, "project");
  await Promise.all([fs.promises.mkdir(registryRoot), fs.promises.mkdir(project)]);
  await fs.promises.writeFile(path.join(registryRoot, "fixture.flow.ts"), source, "utf8");
  await fs.promises.writeFile(path.join(project, "README.md"), "production fixture\n", "utf8");
  const registry = new WorkflowRegistry();
  await registry.refresh(project, { builtinDir: path.join(root, "empty"), userDir: registryRoot, includeProject: false });
  const ref = registry.resolve("user:fixture");
  const prepared = await prepareWorkflowResources({
    workflow: ref.parsed,
    definitionHash: ref.definitionHash,
    cwd: project,
    includeProject: false,
    availableModels: [],
    thinking: "off",
    agentExecutor: new SdkAgentWorkerExecutor().describe(),
    commandExecutor: new SandboxedCommandExecutor().describe(),
    measurementEnvironment: new HostMeasurementEnvironmentProvider().describe(),
  });
  const snapshot = createWorkflowInvocationSnapshot(ref, input, {
    authority: "user",
    projectTrusted: true,
    measurementProfiles: prepared.measurementProfiles,
  });
  const runId = `flow_${stableHash(root).slice(7, 39)}`;
  const runDir = path.join(root, runId);
  await writeWorkflowInvocationSnapshot(runDir, snapshot);
  for (const directory of ["sessions", "workspaces/candidates", "workspaces/checkpoints", "artifacts", "outputs", "context"]) {
    await fs.promises.mkdir(path.join(runDir, directory), { recursive: true, mode: 0o700 });
  }
  const projectSnapshot = await captureProjectSnapshot(project, project, path.join(runDir, "context", "project"));
  await writeCanonical(path.join(runDir, "context", "project-manifest.json"), projectSnapshot);
  await writeCanonical(path.join(runDir, "context", "static-resources.json"), prepared.static);
  const databasePath = path.join(runDir, "run.sqlite");
  const database = WorkflowRunDatabase.create(databasePath, {
    runId,
    snapshot,
    projectSnapshotHash: projectSnapshot.treeHash,
    routeSnapshotHash: prepared.routeSnapshotHash,
    staticResourcesHash: prepared.static.hash,
    contextIdentityHash: stableHash({ prepared: prepared.contextIdentityHash, project: projectSnapshot.manifestHash }),
    ...(options.launch ? { launch: { ...options.launch, projectRoot: project } } : {}),
    safety: {
      concurrency: 2, maximumAgentLaunches: 16, memoryBytes: 1024 * 1024 * 1024, tasks: 128,
      cpuQuotaPercent: 200, cpuWeight: 100, outputBytes: 8 * 1024 * 1024, commandTimeoutMs: 60_000,
    },
    createdAt: new Date().toISOString(),
  });
  database.close();
  return { root, project, runId, runDir, databasePath };
}

function extensionContext(id: string, cwd: string, mode: "tui" | "json") {
  return {
    cwd,
    mode,
    hasUI: mode === "tui",
    signal: new AbortController().signal,
    isProjectTrusted: () => false,
    modelRegistry: { getAvailable: () => [] },
    model: undefined,
    sessionManager: {
      getSessionId: () => id,
      getHeader: () => ({ id }),
      getEntries: () => [],
    },
    ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
  };
}

function fakePi() {
  return {
    getThinkingLevel: () => "off",
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
}

async function writeCanonical(file: string, value: unknown): Promise<void> {
  const handle = await fs.promises.open(file, "wx", 0o600);
  try { await handle.writeFile(`${stableJson(value)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}
